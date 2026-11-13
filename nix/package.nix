{ lib, python3Packages, nodejs }:
let
  project = (builtins.fromTOML (builtins.readFile ../pyproject.toml)).project;
in
python3Packages.buildPythonApplication {
  pname = project.name;
  inherit (project) version;
  pyproject = true;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../pyproject.toml
      ../scripts
      (lib.fileset.fileFilter (file: !(file.hasExt "pyc")) ../src)
      (lib.fileset.fileFilter (file: !(file.hasExt "pyc")) ../tests)
    ];
  };

  build-system = [ python3Packages.setuptools ];
  dependencies = with python3Packages; [ mcp pydantic pypdf ];

  nativeCheckInputs = with python3Packages; [ pytestCheckHook pytest-cov nodejs ];
  preCheck = ''
    mkdir -p .context
  '';
  pytestFlags = [
    "--cov=mail_app_mcp"
    "--cov-report=term-missing"
    "--cov-fail-under=80"
  ];
  postCheck = ''
    node --test tests/test_mail_script.js
  '';
  pythonImportsCheck = [ "mail_app_mcp.server" ];

  meta = {
    description = project.description;
    mainProgram = "mail-app-mcp";
    platforms = lib.platforms.darwin;
  };
}
