"""Event klien → server (PRD §16.6), divalidasi sebagai discriminated union pada field `event`."""
from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter


class _Base(BaseModel):
    v: int = 1


class PingPayload(BaseModel):
    client_ts: int


class Ping(_Base):
    event: Literal["PING"]
    payload: PingPayload


class ResyncPayload(BaseModel):
    last_seq: int


class RequestResync(_Base):
    event: Literal["REQUEST_RESYNC"]
    payload: ResyncPayload


class GoalPayload(BaseModel):
    prompt: str = Field(min_length=10, max_length=4000)
    review_before_run: bool = False
    priority: int = Field(default=2, ge=0, le=3)
    parent_goal_id: str | None = None


class InjectGoal(_Base):
    event: Literal["USER_INJECT_GOAL"]
    payload: GoalPayload


class ApprovalPayload(BaseModel):
    request_id: str
    decision: Literal["APPROVE", "REJECT"]
    reason: str | None = Field(default=None, max_length=500)


class ApprovalResponse(_Base):
    event: Literal["USER_APPROVAL_RESPONSE"]
    payload: ApprovalPayload


class GoalCommandPayload(BaseModel):
    goal_id: str
    command: Literal["START", "CANCEL"]


class GoalCommand(_Base):
    event: Literal["USER_GOAL_COMMAND"]
    payload: GoalCommandPayload


class ChatPayload(BaseModel):
    agent_id: str = Field(pattern=r"^agent_[a-z_]+$")
    message: str = Field(min_length=1, max_length=2000)


class ChatToAgent(_Base):
    event: Literal["USER_CHAT_TO_AGENT"]
    payload: ChatPayload


class MeetingPayload(BaseModel):
    type: Literal["ALL_HANDS"] = "ALL_HANDS"


class StartMeeting(_Base):
    event: Literal["USER_START_MEETING"]
    payload: MeetingPayload


ClientEvent = TypeAdapter(
    Annotated[Ping | RequestResync | InjectGoal | ApprovalResponse | GoalCommand | ChatToAgent | StartMeeting,
              Field(discriminator="event")]
)
