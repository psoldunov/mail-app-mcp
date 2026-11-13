{ pkgs, home-manager, module, package }:
let
  evaluate = settings: home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      module
      {
        home = {
          username = "test";
          homeDirectory = "/Users/test";
          stateVersion = "25.11";
        };
      }
      settings
    ];
  };
  disabled = (evaluate { }).config;
  enabled = (evaluate {
    programs.mcp.servers.existing.command = "/existing/server";
    services.mail-app-mcp = {
      enable = true;
      settings.accounts.work = {
        trash_mailbox = [ "Deleted Items" ];
        allowed_destinations = [ [ "Projects" "2026" ] ];
      };
    };
  }).config;
  server = enabled.programs.mcp.servers.mail-app;
  defaults = (evaluate { services.mail-app-mcp.enable = true; }).config;
  unrestrictedAccount = (evaluate {
    services.mail-app-mcp = { enable = true; settings.accounts.work = { }; };
  }).config;
  overridePackage = pkgs.writeShellScriptBin "mail-app-mcp" "exit 0";
  overridden = (evaluate {
    services.mail-app-mcp = { enable = true; package = overridePackage; };
  }).config;
  credentials = evaluate {
    services.mail-app-mcp = {
      enable = true;
      settings.provider_password = "not-a-supported-setting";
    };
  };
in
assert !disabled.programs.mcp.enable;
assert !(disabled.programs.mcp.servers ? mail-app);
assert enabled.programs.mcp.enable;
assert server.command == "${package}/bin/mail-app-mcp";
assert builtins.head server.args == "--config";
assert builtins.length server.args == 2;
assert builtins.elem package enabled.home.packages;
assert pkgs.lib.all (a: a.assertion) enabled.assertions;
assert enabled.programs.mcp.servers.existing.command == "/existing/server";
assert overridden.programs.mcp.servers.mail-app.command == "${overridePackage}/bin/mail-app-mcp";
assert !(builtins.tryEval credentials.config.programs.mcp.enable).success;
pkgs.runCommand "mail-app-mcp-home-manager" {
  nativeBuildInputs = [ pkgs.jq ];
} ''
  jq -e '.accounts.work == {trash_mailbox: ["Deleted Items"], allowed_destinations: [["Projects", "2026"]]}' \
    ${builtins.elemAt server.args 1}
  jq -e --arg command '${server.command}' '.mcpServers["mail-app"].command == $command' \
    ${enabled.xdg.configFile."mcp/mcp.json".source}
  jq -e '. == {accounts: {}}' ${builtins.elemAt defaults.programs.mcp.servers.mail-app.args 1}
  jq -e '.accounts.work == {trash_mailbox: null, allowed_destinations: null}' \
    ${builtins.elemAt unrestrictedAccount.programs.mcp.servers.mail-app.args 1}
  touch "$out"
''
