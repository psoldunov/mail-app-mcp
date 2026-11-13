self:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.mail-app-mcp;
  inherit (lib) mkEnableOption mkIf mkOption types;
  mailbox = types.addCheck (types.listOf types.str)
    (path: path != [ ] && builtins.length path <= 20 && lib.all (part: part != "") path);
  configFile = (pkgs.formats.json { }).generate "mail-app-mcp.json" cfg.settings;
in {
  options.services.mail-app-mcp = {
    enable = mkEnableOption "the local Apple Mail MCP server";
    package = lib.mkPackageOption self.packages.${pkgs.stdenv.hostPlatform.system} "mail-app-mcp" { };
    settings.accounts = mkOption {
      default = { };
      description = "Explicit mailbox move permissions keyed by Apple Mail account ID.";
      type = types.attrsOf (types.submodule {
        options = {
          trash_mailbox = mkOption {
            type = types.nullOr mailbox;
            default = null;
            description = "Trash mailbox path segments; null disables trash operations.";
          };
          allowed_destinations = mkOption {
            type = types.listOf mailbox;
            default = [ ];
            description = "Mailbox paths to which messages may be moved within this account.";
          };
        };
      });
    };
  };

  config = mkIf cfg.enable {
    assertions = [{
      assertion = pkgs.stdenv.hostPlatform.isDarwin;
      message = "services.mail-app-mcp requires macOS and Apple Mail.";
    }];
    home.packages = [ cfg.package ];
    programs.mcp = {
      enable = true;
      servers.mail-app = {
        command = lib.getExe cfg.package;
        args = [ "--config" (toString configFile) ];
      };
    };
  };
}
