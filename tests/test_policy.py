import pytest
from pydantic import ValidationError

from mail_app_mcp.models import Draft, MessageRef, Settings


def test_account_is_required_for_message_identity():
    with pytest.raises(ValidationError):
        MessageRef(mailbox=["Inbox"], message_id=1, header_message_id="a@example.org")


def test_policy_defaults_to_allow_mailbox_moves():
    settings = Settings()
    assert settings.destination("work", ["Archive"]) == ["Archive"]
    assert settings.trash("work") is None


def test_account_policy_cannot_authorize_another_account():
    settings = Settings.model_validate({"accounts": {"work": {
        "trash_mailbox": ["Deleted Messages"], "allowed_destinations": [["Archive"]]
    }}})
    assert settings.destination("work", ["Archive"]) == ["Archive"]
    assert settings.trash("work") == ["Deleted Messages"]
    assert settings.destination("personal", ["Projects"]) == ["Projects"]
    with pytest.raises(ValueError, match="configured"):
        settings.destination("work", ["Projects"])


@pytest.mark.parametrize("policy", [{}, {"allowed_destinations": None}])
def test_account_entry_without_restrictions_allows_moves(policy):
    settings = Settings.model_validate({"accounts": {"work": policy}})
    assert settings.destination("work", ["Archive"]) == ["Archive"]


def test_explicit_empty_destinations_blocks_moves():
    settings = Settings.model_validate({"accounts": {"work": {"allowed_destinations": []}}})
    with pytest.raises(ValueError, match="configured"):
        settings.destination("work", ["Archive"])


@pytest.mark.parametrize("address", ["a@example.org\nBcc: b@example.org", "invalid", ""])
def test_draft_rejects_invalid_recipients(address):
    with pytest.raises(ValidationError):
        Draft(account_id="work", sender="me@example.org", to=[address], subject="Hi", body="Hi")


def test_trusted_policy_still_cannot_allow_outbox():
    settings = Settings.model_validate({"accounts": {"work": {"allowed_destinations": [["Outbox"]]}}})
    with pytest.raises(ValueError, match="Sending"):
        settings.destination("work", ["Outbox"])


def test_unknown_draft_properties_are_rejected():
    with pytest.raises(ValidationError):
        Draft(account_id="work", sender="me@example.org", to=["a@example.org"], subject="Hi", body="Hi", send=True)


def test_configuration_is_immutable_after_validation():
    settings = Settings.model_validate({"accounts": {"work": {"allowed_destinations": [["Archive"]]}}})
    with pytest.raises(TypeError):
        settings.accounts["other"] = settings.accounts["work"]
    assert settings.model_dump(mode="json")["accounts"]["work"]["allowed_destinations"] == [["Archive"]]
