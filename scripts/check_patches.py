# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile


def find_patches(root):
  return sorted(root.glob("src/**/*.patch"))


def git_apply_command(engine, patch, verbose, check=True, cached=False):
  command = [
    "git",
    "-C",
    str(engine),
    "apply",
    "--ignore-space-change",
    "--ignore-whitespace",
  ]
  if check:
    command.append("--check")
  if cached:
    command.append("--cached")
  if verbose:
    command.append("--verbose")
  command.append(str(patch.resolve()))
  return command


def run_command(command, env=None):
  return subprocess.run(
      command,
      env=env,
      text=True,
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
  )


def check_patch(engine, patch, verbose):
  return run_command(git_apply_command(engine, patch, verbose))


def check_patches_independently(engine, root, patches, verbose):
  failures = []
  checked = 0

  for patch in patches:
    checked += 1
    relative_patch = patch.relative_to(root)
    print(f"[CHECK {checked}/{len(patches)}] {relative_patch}", flush=True)
    result = check_patch(engine, patch, verbose)
    if result.returncode == 0:
      if verbose and result.stdout.strip():
        print(f"[OK] {relative_patch}")
        print(result.stdout.rstrip())
      continue

    failures.append((relative_patch, result.stdout.rstrip()))
    print(f"[FAIL] {relative_patch}")
    if result.stdout.strip():
      print(result.stdout.rstrip())

  return failures, checked


def temporary_index_env(engine):
  git_dir_result = run_command(["git", "-C", str(engine), "rev-parse", "--git-dir"])
  if git_dir_result.returncode != 0:
    raise RuntimeError(git_dir_result.stdout.strip())

  git_dir = pathlib.Path(git_dir_result.stdout.strip())
  if not git_dir.is_absolute():
    git_dir = engine / git_dir

  source_index = git_dir / "index"
  if not source_index.is_file():
    raise RuntimeError(f"Could not find Git index at {source_index}")

  temp_dir = tempfile.TemporaryDirectory(prefix="zen-patch-index-")
  temp_index = pathlib.Path(temp_dir.name) / "index"
  shutil.copy2(source_index, temp_index)

  env = os.environ.copy()
  env["GIT_INDEX_FILE"] = str(temp_index)
  return temp_dir, env


def check_patches_sequentially(engine, root, patches, verbose, keep_going):
  failures = []
  checked = 0
  temp_dir, env = temporary_index_env(engine)

  try:
    for patch in patches:
      checked += 1
      relative_patch = patch.relative_to(root)
      print(f"[CHECK {checked}/{len(patches)}] {relative_patch}", flush=True)
      check_result = run_command(
          git_apply_command(engine, patch, verbose, check=True, cached=True), env)
      if check_result.returncode != 0:
        failures.append((relative_patch, check_result.stdout.rstrip()))
        print(f"[FAIL] {relative_patch}")
        if check_result.stdout.strip():
          print(check_result.stdout.rstrip())
        if not keep_going:
          print("\nStopped at the first sequential failure.")
          print("Pass --keep-going to continue, but later failures may be cascading.")
          break
        continue

      apply_result = run_command(
          git_apply_command(engine, patch, verbose, check=False, cached=True), env)
      if apply_result.returncode != 0:
        failures.append((relative_patch, apply_result.stdout.rstrip()))
        print(f"[FAIL] {relative_patch}")
        if apply_result.stdout.strip():
          print(apply_result.stdout.rstrip())
        if not keep_going:
          print("\nStopped at the first sequential failure.")
          print("Pass --keep-going to continue, but later failures may be cascading.")
          break
        continue

      if verbose:
        print(f"[OK] {relative_patch}")
  finally:
    temp_dir.cleanup()

  return failures, checked


def print_compact_failures(failures):
  print("\n--- BEGIN PATCH ERRORS ---")
  for patch, output in failures:
    error_lines = [
        line.strip() for line in output.splitlines()
        if line.strip().lower().startswith("error:")
    ]
    if not error_lines:
      nonempty_lines = [line.strip() for line in output.splitlines() if line.strip()]
      error_lines = nonempty_lines[-1:] or ["error: patch check failed"]

    print(f"[FAIL] {patch}")
    for line in error_lines:
      print(line)
  print("--- END PATCH ERRORS ---")


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
  parser.add_argument(
      "--independent",
      action="store_true",
      help="Check each patch against the pristine engine checkout. This is noisy for dependent patches.")
  parser.add_argument(
      "--keep-going",
      action="store_true",
      help="In sequential mode, continue after a failure. Later failures may be cascading.")
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
  if args.independent:
    failures, checked = check_patches_independently(
        engine, root, patches, args.verbose)
  else:
    failures, checked = check_patches_sequentially(
        engine, root, patches, args.verbose, args.keep_going)

  passed = checked - len(failures)
  print(f"\nChecked {checked} of {len(patches)} patches: {passed} passed, {len(failures)} failed.")

  if failures:
    print("\nFailing patches:")
    for patch, _output in failures:
      print(f"- {patch}")
    print_compact_failures(failures)
    return 1
  return 0


if __name__ == "__main__":
  sys.exit(main())
