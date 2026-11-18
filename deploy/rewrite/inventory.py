"""List declared routes, database tables and environment switches without importing the app."""
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / ".rewrite-oracle"


def collect(root):
    routes, tables, switches = {}, {}, set()
    for path in sorted((root / "superagent").rglob("*.py")):
        source = path.relative_to(root).as_posix()
        tree = ast.parse(path.read_text("utf-8-sig"))
        prefix = ""
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                call = node.value
                if isinstance(call.func, ast.Name) and call.func.id == "APIRouter":
                    prefix = next((ast.literal_eval(k.value) for k in call.keywords if k.arg == "prefix"), "")
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute):
                        method = dec.func.attr.upper()
                        verbs = [method] if method in {"GET", "POST", "PATCH", "PUT", "DELETE"} else []
                        if method == "API_ROUTE":
                            verbs = next(ast.literal_eval(k.value) for k in dec.keywords if k.arg == "methods")
                        for verb in verbs:
                            route = f"{verb} {prefix}{ast.literal_eval(dec.args[0])}"
                            routes[route] = source + ":" + str(node.lineno)
            if isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__tablename__" for t in item.targets):
                        tables[ast.literal_eval(item.value)] = source + ":" + str(node.lineno)
        switches.update(n.value for n in ast.walk(tree) if isinstance(n, ast.Constant)
                        and isinstance(n.value, str) and n.value.startswith("SUPERAGENT_") and n.value.isidentifier())
    return {"routes": routes, "tables": tables, "environment_names": sorted(switches)}


if __name__ == "__main__":
    inventory = collect(SNAPSHOT)
    dest = ROOT / "docs/rewrite/surface.json"
    dest.write_text(json.dumps(inventory, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print({name: len(items) for name, items in inventory.items()})
