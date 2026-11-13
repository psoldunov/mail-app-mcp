"""Validated MCP inputs and owner-controlled mailbox policy."""

import json
import re
from collections.abc import Mapping
from types import MappingProxyType
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_serializer, field_validator

Identifier = Annotated[str, StringConstraints(min_length=1, max_length=512, pattern=r"^[^\x00-\x1f]+$")]
Segment = Annotated[str, StringConstraints(min_length=1, max_length=255, pattern=r"^[^\x00-\x1f]+$")]
Mailbox = Annotated[tuple[Segment, ...], Field(min_length=1, max_length=20)]
Address = Annotated[str, StringConstraints(min_length=3, max_length=320, pattern=r"^[^\s<>@,;]+@[^\s<>@,;]+$")]
Body = Annotated[str, StringConstraints(max_length=100_000)]
FORBIDDEN_FOLDERS = frozenset({"outbox", "send later", "scheduled", "scheduled messages"})


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class MessageRef(Input):
    account_id: Identifier
    mailbox: Mailbox
    message_id: Annotated[int, Field(strict=True, gt=0, le=2**53 - 1)]
    header_message_id: Annotated[str, StringConstraints(max_length=2048)]


class Draft(Input):
    account_id: Identifier
    sender: Address
    to: Annotated[tuple[Address, ...], Field(min_length=1, max_length=100)]
    cc: Annotated[tuple[Address, ...], Field(max_length=100)] = ()
    bcc: Annotated[tuple[Address, ...], Field(max_length=100)] = ()
    subject: Annotated[str, StringConstraints(max_length=998, pattern=r"^[^\r\n\x00]*$")]
    body: Body


class AccountPolicy(Input):
    trash_mailbox: Mailbox | None = None
    allowed_destinations: tuple[Mailbox, ...] = ()

    @field_validator("allowed_destinations")
    @classmethod
    def bounded_destinations(cls, value):
        if len(value) > 100:
            raise ValueError("At most 100 destinations per account")
        return value


class Settings(Input):
    accounts: Mapping[Identifier, AccountPolicy] = Field(default_factory=lambda: MappingProxyType({}))

    @field_validator("accounts")
    @classmethod
    def immutable_accounts(cls, value):
        return MappingProxyType(dict(value))

    @field_serializer("accounts")
    def serialize_accounts(self, value):
        return {key: policy.model_dump(mode="json") for key, policy in value.items()}

    def destination(self, account_id: str, path: list[str] | tuple[str, ...]) -> list[str]:
        policy = self.accounts.get(account_id)
        target = tuple(path)
        if any(re.sub(r"\s+", " ", part.strip().casefold()) in FORBIDDEN_FOLDERS for part in target):
            raise ValueError("Sending mailboxes cannot be move destinations")
        if policy is None or target not in (*policy.allowed_destinations, policy.trash_mailbox):
            configured = () if policy is None else tuple(
                path for path in (*policy.allowed_destinations, policy.trash_mailbox) if path is not None
            )
            raise ValueError(
                "Destination is not configured for this account. "
                f"Configured destinations: {json.dumps(configured, ensure_ascii=False)}. "
                "To change these, update the owner-controlled policy and restart the server"
            )
        return list(target)

    def trash(self, account_id: str) -> list[str]:
        policy = self.accounts.get(account_id)
        if policy is None or policy.trash_mailbox is None:
            raise ValueError("Trash mailbox is not configured for this account")
        return self.destination(account_id, policy.trash_mailbox)
