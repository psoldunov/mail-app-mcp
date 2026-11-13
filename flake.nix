{
  description = "Local Apple Mail MCP server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, home-manager }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      homeManagerModules.default = import ./nix/home-manager.nix self;

      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in rec {
          mail-app-mcp = pkgs.callPackage ./nix/package.nix { };
          default = mail-app-mcp;
        });

      checks = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          package = self.packages.${system}.default;
          home-manager = import ./nix/tests/home-manager.nix {
            inherit pkgs home-manager;
            module = self.homeManagerModules.default;
            package = self.packages.${system}.default;
          };
        });
    };
}
