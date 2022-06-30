{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, flake-utils, nixpkgs }:
    flake-utils.lib.eachDefaultSystem (sys:
      let
        pkgs = nixpkgs.legacyPackages.${sys};
      in
      {
        devShell = with pkgs; mkShell {
          buildInputs = [
            nodejs
          ];
        };
      });
}
