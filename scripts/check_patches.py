# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import pathlib
import subprocess
import sys


def find_patches(root):
  return sorted(root.glob("src/**/*.patch"))


def check_patch(engine, patch, verbose):
  command = [
    "git",
    "-C",
    str(engine),
    "apply",
    "--check",
    "--ignore-space-change",
    "--ignore-whitespace",
  ]
  if verbose:
    command.append("--verbose")
  command.append(str(patch.resolve()))

  return subprocess.run(
      command,
      text=True,
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
  )


def main():
  parser = argparse.ArgumentParser(
      description="Dry-run all Zen patch files against the local Firefox engine checkout.")
  parser.add_argument(
      "--engine",
      type=pathlib.Path,
      default=pathlib.Path("engine"),
      help="Path to the Firefox engine checkout. Defaults to ./engine.")
  parser.add_argument(
      "--root",
      type=pathlib.Path,
      default=pathlib.Path("."),
      help="Path to the Zen repository root. Defaults to the current directory.")
  parser.add_argument(
      "--verbose",
      action="store_true",
      help="Pass --verbose to git apply and print successful patch output too.")
  args = parser.parse_args()

  root = args.root.resolve()
  engine = args.engine.resolve()
  if not (root / "surfer.json").is_file():
    print(f"error: {root} does not look like the Zen repository root", file=sys.stderr)
    return 2
  if not engine.is_dir():
    print(f"error: {engine} does not exist; run npm run download first", file=sys.stderr)
    return 2

  patches = find_patches(root)
  failures = []

  for patch in patches:
    relative_patch = patch.relative_to(root)
    result = check_patch(engine, patch, args.verbose)
    if result.returncode == 0:
      if args.verbose and result.stdout.strip():
        print(f"[OK] {relative_patch}")
        print(result.stdout.rstrip())
      continue

    failures.append((relative_patch, result.stdout.rstrip()))
    print(f"[FAIL] {relative_patch}")
    if result.stdout.strip():
      print(result.stdout.rstrip())

  passed = len(patches) - len(failures)
  print(f"\nChecked {len(patches)} patches: {passed} passed, {len(failures)} failed.")

  if failures:
    print("\nFailing patches:")
    for patch, _output in failures:
      print(f"- {patch}")
    return 1
  return 0


if __name__ == "__main__":
  sys.exit(main())
