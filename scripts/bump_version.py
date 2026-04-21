# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

import json
from pathlib import Path

import click
import tomlkit
from jupyter_releaser.util import get_version, run
from packaging.requirements import Requirement
from packaging.version import Version as parse_version


LERNA_CMD = "jlpm run lerna version --no-push --force-publish --no-git-tag-version"


def strip_twd(version: str) -> str:
    """Remove any existing +twdN local version segment (Python)."""
    return version.split("+")[0]


def strip_js_twd(version: str) -> str:
    """Remove any existing -twd.N prerelease segment (JS)."""
    import re
    return re.sub(r"-twd\.\d+$", "", version)


def increment_version(current, spec):
    curr = parse_version(current)

    if spec == "major":
        spec = f"{curr.major + 1}.0.0.a0"

    elif spec == "minor":
        spec = f"{curr.major}.{curr.minor + 1}.0.a0"

    elif spec == "release":
        p, x = curr.pre
        if p == "a":
            p = "b"
        elif p == "b":
            p = "rc"
        elif p == "rc":
            p = None
        suffix = f"{p}0" if p else ""
        spec = f"{curr.major}.{curr.minor}.{curr.micro}{suffix}"

    elif spec == "next":
        spec = f"{curr.major}.{curr.minor}."
        if curr.pre:
            p, x = curr.pre
            spec += f"{curr.micro}{p}{x + 1}"
        else:
            spec += f"{curr.micro + 1}"

    elif spec == "patch":
        spec = f"{curr.major}.{curr.minor}."
        if curr.pre:
            spec += f"{curr.micro}"
        else:
            spec += f"{curr.micro + 1}"
    else:
        raise ValueError("Unknown version spec")

    return spec


@click.command()
@click.option("--force", default=False, is_flag=True)
@click.option("--skip-if-dirty", default=False, is_flag=True)
@click.option("--twd", default=None, type=int, help="TWD build suffix number added to version (e.g. 30 → +twd30 for Python, -twd.30 for JS)")
@click.argument("spec", nargs=1, required=False, default=None, help="Version specifier: major, minor, patch, release, next, or an explicit version string")
def bump(force, skip_if_dirty, twd, spec):
    if spec is None and twd is None:
        raise click.UsageError("Must provide spec and/or --twd")

    status = run("git status --porcelain").strip()
    if len(status) > 0:
        if skip_if_dirty:
            return
        raise Exception("Must be in a clean git state with no untracked files")

    HERE = Path(__file__).parent.parent.resolve()

    if spec is not None:
        current = get_version()
    else:
        # twd-only: read base version from a project _version.py directly
        version_file = next(HERE.glob("projects/**/_version.py"))
        raw = version_file.read_text().splitlines()[0].split(" = ")[1].strip("'\"")
        current = strip_twd(raw)

    if spec is not None:
        py_version = parse_version(increment_version(strip_twd(current), spec))
        # Derive JS version from the incremented Python version
        js_version = f"{py_version.major}.{py_version.minor}.{py_version.micro}"
        if py_version.pre:
            p, x = py_version.pre
            p = p.replace("a", "alpha").replace("b", "beta")
            js_version += f"-{p}.{x}"
    else:
        # twd-only: read JS version independently from the packages directory
        js_pkg = next(HERE.glob("packages/*/package.json"))
        with js_pkg.open() as f:
            js_pkg_data = json.load(f)
        js_version = strip_js_twd(js_pkg_data["version"])

    if twd is not None:
        js_version += f"-twd.{twd}"

    # bump the JS packages
    lerna_cmd = f"{LERNA_CMD} {js_version}"
    if force:
        lerna_cmd += " --yes"
    run(lerna_cmd)

    project_pins = {}

    # bump the Python packages
    for version_file in HERE.glob("projects/**/_version.py"):
        content = version_file.read_text().splitlines()
        variable, current = content[0].split(" = ")
        if variable != "__version__":
            raise ValueError(
                f"Version file {version_file} has unexpected content;"
                f" expected __version__ assignment in the first line, found {variable}"
            )
        current = strip_twd(current.strip("'\""))
        if spec is not None:
            version_spec = increment_version(current, spec)
        else:
            version_spec = current
        if twd is not None:
            version_spec += f"+twd{twd}"
        version_file.write_text(f'__version__ = "{version_spec}"\n')
        project = version_file.parent.name
        project_pins[project] = version_spec

    # bump the required version in jupyter-collaboration metapackage
    # to ensure that users can just upgrade `jupyter-collaboration`
    # and get all fixes for free.
    # Formatting based on https://stackoverflow.com/questions/70721025/tomlkit-nicely-formatted-array-with-inline-tables
    metapackage = "jupyter-collaboration"
    metapackage_toml_path = HERE / "projects" / metapackage / "pyproject.toml"
    metapackage_toml = tomlkit.parse(metapackage_toml_path.read_text())
    old_dependencies = metapackage_toml.get("project").get("dependencies")
    metapackage_toml.get("project").remove("dependencies")
    dependencies = tomlkit.array()
    for key in sorted(project_pins):
        if key != metapackage.replace("-", "_"):
            # Use the base version (without local +twd suffix) for the upper bound
            base_version = strip_twd(project_pins[key])
            next_major = f"{parse_version(base_version).major + 1}"
            dependencies.add_line(key + ">=" + project_pins[key] + ",<" + next_major)
    # re-add other dependencies
    for dependency in old_dependencies:
        requirement = Requirement(dependency)
        if requirement.name.replace("-", "_") not in project_pins:
            dependencies.add_line(dependency)
    metapackage_toml.get("project").add("dependencies", dependencies.multiline(True))
    metapackage_toml_path.write_text(tomlkit.dumps(metapackage_toml))

    path = HERE.joinpath("package.json")
    if path.exists():
        with path.open(mode="r") as f:
            data = json.load(f)

        data["version"] = js_version

        with path.open(mode="w") as f:
            json.dump(data, f, indent=2)

    else:
        raise FileNotFoundError(f"Could not find package.json under dir {path!s}")


if __name__ == "__main__":
    bump()
