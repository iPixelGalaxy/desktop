# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import subprocess
import sys


DEFAULT_ZEN_DISPLAY_VERSION = "1.21.3b"


def run(command):
  print(f"+ {' '.join(command)}")
  return subprocess.run(command).returncode


def main():
  parser = argparse.ArgumentParser(
      description="Select a Firefox channel/version, import Zen patches, and optionally build.")
  parser.add_argument("channel", choices=["beta", "nightly", "stable"])
  parser.add_argument("--version", help="Exact Firefox version to pin, for example 154.0a1.")
  parser.add_argument(
      "--latest",
      action="store_true",
      help="Fetch the latest version for the selected channel from Mozilla product details.")
  parser.add_argument("--candidate-build", type=int, default=1)
  parser.add_argument(
      "--display-version",
      default=DEFAULT_ZEN_DISPLAY_VERSION,
      help=f"Zen display version to pass to surfer build. Defaults to {DEFAULT_ZEN_DISPLAY_VERSION}.")
  parser.add_argument(
      "--check-patches",
      action="store_true",
      help="Run the patch dry-run checker after download and before import.")
  parser.add_argument(
      "--no-build",
      action="store_true",
      help="Stop after download/import. Useful while porting patches.")
  args, build_args = parser.parse_known_args()

  selector = [
    "python3",
    "scripts/select_firefox_channel.py",
    args.channel,
    "--candidate-build",
    str(args.candidate_build),
  ]
  if args.latest:
    selector.append("--latest")
  elif args.version:
    selector.extend(["--version", args.version])
  else:
    parser.error("Provide exactly one of --version or --latest.")

  for command in (
      selector,
      ["npm", "run", "download"],
  ):
    status = run(command)
    if status != 0:
      return status

  if args.check_patches:
    status = run(["npm", "run", "patches:check"])
    if status != 0:
      return status

  status = run(["npm", "run", "import", "--", "--verbose"])
  if status != 0 or args.no_build:
    return status

  return run([
    "npm",
    "run",
    "build",
    "--",
    "--display-version",
    args.display_version,
    *build_args,
  ])


if __name__ == "__main__":
  sys.exit(main())
