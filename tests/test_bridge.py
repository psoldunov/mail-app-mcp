import json
import subprocess
import sys
from unittest.mock import patch

import pytest

from mail_app_mcp.bridge import BridgeError, MailBridge, OutcomeUnknown, write_lock


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


def test_excessive_output_is_an_uncertain_outcome():
    actual_process = subprocess.Popen
    def fake_mail(command, **options):
        return actual_process([sys.executable, "-c", "print('x' * 3000000)"], **options)
    with patch("sys.platform", "darwin"), patch("subprocess.Popen", side_effect=fake_mail):
        with pytest.raises(OutcomeUnknown, match="excessive"):
            MailBridge().call("create_draft", {})


def test_lock_rejects_symlink(tmp_path):
    (tmp_path / "writes.lock").symlink_to(tmp_path / "elsewhere")
    with pytest.raises(BridgeError):
        with write_lock(tmp_path):
            pytest.fail("Acquired symlinked lock")
