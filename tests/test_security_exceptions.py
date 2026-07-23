import ast
import re
import unittest
from pathlib import Path


class SecurityExceptionTests(unittest.TestCase):
    def test_sha1_exists_only_for_rfc6455_websocket_accept(self):
        web = Path(__file__).resolve().parents[1] / "web"
        textual = []
        calls = []

        for path in sorted(web.rglob("*.py")):
            source = path.read_text(encoding="utf-8")
            relative = path.relative_to(web).as_posix()
            for line_number, line in enumerate(source.splitlines(), 1):
                if re.search(r"\bsha1\b", line, re.IGNORECASE):
                    textual.append((relative, line_number, line.strip()))

            tree = ast.parse(source, filename=str(path))

            class Visitor(ast.NodeVisitor):
                def __init__(self):
                    self.functions = []

                def visit_FunctionDef(self, node):
                    self.functions.append(node.name)
                    self.generic_visit(node)
                    self.functions.pop()

                def visit_Call(self, node):
                    function = node.func
                    direct = isinstance(function, ast.Attribute) and function.attr == "sha1"
                    named = isinstance(function, ast.Name) and function.id == "sha1"
                    dynamic = (
                        isinstance(function, ast.Attribute)
                        and function.attr == "new"
                        and node.args
                        and isinstance(node.args[0], ast.Constant)
                        and str(node.args[0].value).lower() == "sha1"
                    )
                    if direct or named or dynamic:
                        calls.append((relative, tuple(self.functions)))
                    self.generic_visit(node)

            Visitor().visit(tree)

        self.assertEqual(
            calls,
            [("realtime_server.py", ("websocket_accept",))],
            "SHA-1 is permitted only by the fixed RFC 6455 handshake",
        )
        self.assertEqual(
            len(textual),
            1,
            "The Semgrep exception must not hide another SHA-1 use under web/",
        )
        self.assertEqual(textual[0][0], "realtime_server.py")
        self.assertIn("hashlib.sha1(raw)", textual[0][2])


if __name__ == "__main__":
    unittest.main()
