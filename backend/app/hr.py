"""Rekrutmen karyawan baru oleh HRD (Sena): kebijakan deterministik, bukan keputusan LLM.

Tidak semua permintaan dikabulkan: kalau keahliannya sudah ada di kantor, orangnya dipinjam; kalau kuota atau
meja habis, ditolak; kalau kasusnya meragukan, HRD bertanya ke Supervisor; hanya kebutuhan yang jelas direkrut langsung.
"""
from dataclasses import dataclass
from enum import Enum

MAX_HIRES = 10
ASK_AFTER = 3
HRD = "agent_sena"

TIER_BY_DIVISION = {"engineering": "T4_LOCAL_CODE", "creative": "T2_FAST", "marketing": "T2_FAST", "operations": "T3_DOC"}
NAMES = ["Asahi", "Botan", "Chika", "Daigo", "Fumi", "Genta", "Hoshi", "Itsuki", "Junko", "Kohei",
         "Minato", "Noa", "Osamu", "Risa", "Sho", "Tsubasa", "Umi", "Wataru", "Yoru", "Zen"]


class Decision(str, Enum):
    HIRE = "HIRE"
    ASK_BOSS = "ASK_BOSS"
    BORROW = "BORROW"
    REJECT = "REJECT"


@dataclass
class Ruling:
    decision: Decision
    reason: str
    borrow_id: str | None = None


def _coverage(missing: set[str], skills: list[str]) -> float:
    have = [s.lower() for s in skills]
    same = lambda m, s: m == s or (min(len(m), len(s)) >= 4 and (m in s or s in m))
    return sum(any(same(m, s) for s in have) for m in missing) / len(missing)


def decide(missing: list[str], profiles: dict[str, dict], *, has_desk: bool, hires_total: int,
           hires_this_goal: int) -> Ruling:
    need = {m.lower().strip() for m in missing if m.strip()}
    if not need:
        return Ruling(Decision.REJECT, "Permintaan tidak menyebut keahlian yang dibutuhkan.")
    best_id, best = None, 0.0
    for p in profiles.values():
        if p["kind"] == "llm" and not p.get("fired") and (c := _coverage(need, p["skills"])) > best:
            best_id, best = p["agent_id"], c
    if best_id and best >= 0.5:
        p = profiles[best_id]
        return Ruling(Decision.BORROW, f"Keahlian itu sudah dimiliki {p['name']} ({p['role']}). Tidak perlu orang baru.",
                      best_id)
    if hires_total >= MAX_HIRES:
        return Ruling(Decision.REJECT, f"Kuota rekrutmen habis ({MAX_HIRES} orang).")
    if not has_desk:
        return Ruling(Decision.REJECT, "Tidak ada meja kosong di divisi ini.")
    if best > 0:
        return Ruling(Decision.ASK_BOSS, f"Sebagian keahlian sudah ada di {profiles[best_id]['name']}, tapi belum cukup.")
    if hires_this_goal >= 1:
        return Ruling(Decision.ASK_BOSS, "Goal ini sudah merekrut satu orang; tambahan berikutnya butuh persetujuan.")
    if hires_total >= ASK_AFTER:
        return Ruling(Decision.ASK_BOSS, f"Sudah {hires_total} rekrutmen; penambahan berikutnya butuh persetujuan.")
    if len(need) > 3:
        return Ruling(Decision.ASK_BOSS, "Permintaan keahliannya terlalu lebar untuk satu orang.")
    return Ruling(Decision.HIRE, "Keahlian ini belum dimiliki siapa pun dan masih ada meja kosong.")


def new_profile(*, number: int, used_names: set[str], role: str, division: str, skills: list[str], desk_id: str,
                lead_id: str) -> dict:
    """Profil karyawan baru dalam bentuk yang sama dengan entri config/agents.yaml."""
    name = next((n for n in NAMES if n not in used_names), f"Staf{number}")
    skills = list(dict.fromkeys(s.lower().strip().replace(" ", "_") for s in skills if s.strip()))[:4]
    role = (role.strip() or f"{skills[0].replace('_', ' ').title()} Specialist")[:40]
    listed = ", ".join(skills)
    return {
        "agent_id": f"agent_{name.lower()}", "number": number, "name": name, "division": division, "role": role,
        "kind": "llm", "desk_id": desk_id, "reports_to": lead_id, "tier": TIER_BY_DIVISION[division],
        "archetype": f"Karyawan baru, {role}", "skills": skills, "tools": [],
        "persona_prompt": (f"Kamu adalah {name}, {role} di divisi {division} CyberVerse Corp. Kamu karyawan baru yang "
                           f"direkrut karena keahlianmu: {listed}. Sigap, teliti, dan rendah hati; kerjakan task "
                           "sesuai arahan lead dan laporkan hasil apa adanya."),
        "ambient_lines": ["Masih menyesuaikan ritme kantor ini.", "Kalau ada yang perlu dibantu, bilang saja."],
        "job": f"Menangani pekerjaan yang butuh {listed.replace('_', ' ')}.",
    }
