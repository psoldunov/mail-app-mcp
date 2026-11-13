import json
import subprocess
import sys
from unittest.mock import patch

import pytest

from mail_app_mcp.bridge import BridgeError, MailBridge, OutcomeUnknown, decode_response, write_lock


def test_unknown_operation_never_starts_automation():
    with patch("subprocess.Popen") as run:
        with pytest.raises(BridgeError, match="Unsupported"):
            MailBridge().call("send", {})
        run.assert_not_called()


def test_script_is_fixed_and_hostile_input_is_only_json_data():
    payload = {"body": '\"; Mail.send(); //\n$HOME'}
    actual_process = subprocess.Popen
    program = "import json,sys; request=json.load(sys.stdin); print(json.dumps({'ok':True,'result':{'args':request['args']}}))"
    def fake_mail(command, **options):
        return actual_process([sys.executable, "-c", program], **options)
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=fake_mail) as run:
        assert MailBridge().call("create_draft", payload) == {"args": payload}
        args, options = run.call_args
        assert args[0][:3] == ["/usr/bin/osascript", "-l", "JavaScript"]
        assert payload["body"] not in args[0]
        assert options["shell"] is False


@pytest.mark.parametrize("output", ['not json', '{"ok":true,"result":[]}', '{"ok":false,"error":"Mail is closed"}'])
def test_bridge_rejects_bad_responses(output):
    actual_process = subprocess.Popen
    def fake_mail(command, **options):
        return actual_process([sys.executable, "-c", "import sys; print(sys.argv[1])", output], **options)
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=fake_mail):
        with pytest.raises(BridgeError):
            MailBridge().call("list_accounts", {})


def test_timeout_is_explicitly_uncertain():
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=subprocess.TimeoutExpired("osascript", 30)):
        with pytest.raises(OutcomeUnknown, match="Do not retry"):
            MailBridge().call("create_draft", {})


@pytest.mark.parametrize("operation", [
    "list_accounts", "list_mailboxes", "list_messages", "search_messages",
    "read_message", "save_attachment",
])
def test_read_timeout_identifies_operation_and_is_safe_to_retry(operation):
    with patch("sys.platform", "darwin"), patch(
        "subprocess.Popen", side_effect=subprocess.TimeoutExpired("osascript", 30)
    ):
        with pytest.raises(BridgeError) as caught:
            MailBridge().call(operation, {})
    error = caught.value
    assert not isinstance(error, OutcomeUnknown)
    assert error.operation == operation
    assert error.retry_safe is True
    assert operation in str(error)
    assert "retry_safe=true" in str(error)
    assert "timed out" in str(error)
    assert "write" not in str(error)


def test_excessive_output_is_an_uncertain_outcome():
    actual_process = subprocess.Popen
    def fake_mail(command, **options):
        return actual_process([sys.executable, "-c", "print('x' * 3000000)"], **options)
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=fake_mail):
        with pytest.raises(OutcomeUnknown, match="excessive"):
            MailBridge().call("create_draft", {})


@pytest.mark.parametrize("output", [
    b'not json', b'{"ok":true,"result":[]}', b'{}', b'\xff',
    b'{"ok":false,"error":"Outcome unknown: Apple event failed"}',
])
def test_read_invalid_output_is_safe_to_retry(output):
    actual_process = subprocess.Popen
    def fake_mail(command, **options):
        return actual_process([
            sys.executable, "-c", "import sys; sys.stdout.buffer.write(bytes.fromhex(sys.argv[1]))",
            output.hex(),
        ], **options)
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=fake_mail):
        with pytest.raises(BridgeError) as caught:
            MailBridge().call("list_messages", {})
    assert not isinstance(caught.value, OutcomeUnknown)
    assert caught.value.retry_safe is True
    assert "list_messages" in str(caught.value)
    assert "write outcome" not in str(caught.value)


def test_read_excessive_output_is_safe_to_retry():
    actual_process = subprocess.Popen
    def fake_mail(command, **options):
        return actual_process([sys.executable, "-c", "print('x' * 3000000)"], **options)
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=fake_mail):
        with pytest.raises(BridgeError) as caught:
            MailBridge().call("read_message", {})
    assert not isinstance(caught.value, OutcomeUnknown)
    assert caught.value.retry_safe is True
    assert "output budget" in str(caught.value)


@pytest.mark.parametrize("operation,uncertain", [("list_messages", False), ("create_draft", True)])
def test_script_failure_preserves_cause_and_number(operation, uncertain):
    envelope = {
        "ok": False,
        "error": ("Outcome unknown: " if uncertain else "") + "Not authorized to send Apple events to Mail",
        "operation": operation,
        "apple_script_error_number": -1743,
    }
    actual_process = subprocess.Popen
    def fake_mail(command, **options):
        return actual_process([
            sys.executable, "-c", "import sys; print(sys.argv[1])", json.dumps(envelope),
        ], **options)
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=fake_mail):
        with pytest.raises(BridgeError) as caught:
            MailBridge().call(operation, {})
    error = caught.value
    assert isinstance(error, OutcomeUnknown) is uncertain
    assert error.operation == operation
    assert error.retry_safe is (not uncertain)
    assert error.apple_script_error_number == -1743
    assert "Not authorized to send Apple events to Mail" in str(error)
    assert "-1743" in str(error)
    assert f"retry_safe={str(not uncertain).lower()}" in str(error)


@pytest.mark.parametrize("operation,uncertain", [("list_messages", False), ("create_draft", True)])
def test_nonzero_exit_retains_bounded_stderr_and_retry_safety(operation, uncertain):
    actual_process = subprocess.Popen
    def fake_mail(command, **options):
        return actual_process([
            sys.executable, "-c",
            "import sys; sys.stderr.write('Apple event denied (-1743): ' + 'x' * 4000); sys.exit(1)",
        ], **options)
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=fake_mail):
        with pytest.raises(BridgeError) as caught:
            MailBridge().call(operation, {})
    error = caught.value
    assert isinstance(error, OutcomeUnknown) is uncertain
    assert error.operation == operation
    assert error.retry_safe is (not uncertain)
    assert "Apple event denied (-1743)" in str(error)
    assert "exit code 1" in str(error)
    assert len(str(error)) < 1500


def test_launch_error_keeps_underlying_cause_and_read_retry_safety():
    with patch("sys.platform", "darwin"), patch(
        "subprocess.Popen", side_effect=PermissionError("osascript permission denied")
    ):
        with pytest.raises(BridgeError) as caught:
            MailBridge().call("list_accounts", {})
    assert not isinstance(caught.value, OutcomeUnknown)
    assert caught.value.operation == "list_accounts"
    assert caught.value.retry_safe is True
    assert "osascript permission denied" in str(caught.value)


@pytest.mark.parametrize("output", [
    'not json', '{"ok":true,"result":[]}', '{}', 'x' * 2_000_001,
    '{"ok":false,"error":"Outcome unknown: Draft may have been created"}',
])
@pytest.mark.parametrize("operation", [None, "create_draft", "show_message", "show_draft"])
def test_uncertain_decoder_errors_preserve_legacy_and_write_behavior(output, operation):
    with pytest.raises(OutcomeUnknown) as caught:
        decode_response(output, operation=operation)
    assert caught.value.retry_safe is False
    assert "Do not retry" in str(caught.value)


@pytest.mark.parametrize("number", [None, "-1743", True, {"code": -1743}])
def test_decoder_ignores_invalid_error_number_and_uses_requested_operation(number):
    output = json.dumps({
        "ok": False, "error": "No such message", "operation": "create_draft",
        "apple_script_error_number": number,
    })
    with pytest.raises(BridgeError) as caught:
        decode_response(output, operation="read_message")
    assert caught.value.operation == "read_message"
    assert caught.value.retry_safe is True
    assert caught.value.apple_script_error_number is None
    assert "No such message" in str(caught.value)


def test_lock_rejects_symlink(tmp_path):
    (tmp_path / "writes.lock").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(BridgeError):
        with write_lock(tmp_path):
            pytest.fail("Acquired symlinked lock")
