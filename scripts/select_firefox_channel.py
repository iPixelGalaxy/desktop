# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import json
import pathlib
import urllib.request


PRODUCT_DETAILS_URL = "https://product-details.mozilla.org/1.0/firefox_versions.json"

VERSION_KEYS = {
  "stable": "LATEST_FIREFOX_VERSION",
  "beta": "LATEST_FIREFOX_DEVEL_VERSION",
  "nightly": "FIREFOX_NIGHTLY",
}


def latest_version_for(channel):
  with urllib.request.urlopen(PRODUCT_DETAILS_URL, timeout=30) as response:
    versions = json.load(response)
  key = VERSION_KEYS[channel]
  try:
    return versions[key]
  except KeyError as exc:
    raise RuntimeError(f"Mozilla product details did not include {key}") from exc


def update_surfer_json(path, channel, version, candidate_build):
  with path.open("r", encoding="utf-8") as file:
    data = json.load(file)

  data.setdefault("version", {})
  data["version"]["product"] = "firefox"
  data["version"]["version"] = version
  data["version"]["candidate"] = version
  data["version"]["candidateBuild"] = candidate_build
  data["version"]["channel"] = channel

  with path.open("w", encoding="utf-8") as file:
    json.dump(data, file, indent=2)
    file.write("\n")


def main():
  parser = argparse.ArgumentParser(
      description="Select the Firefox base version used by surfer.")
  parser.add_argument("channel", choices=sorted(VERSION_KEYS))
  parser.add_argument(
      "--version",
      help="Exact Firefox version to pin, for example 152.0.1, 153.0b9, or 154.0a1.")
  parser.add_argument(
      "--latest",
      action="store_true",
      help="Fetch the latest version for the selected channel from Mozilla product details.")
  parser.add_argument(
      "--candidate-build",
      type=int,
      default=1,
      help="Firefox candidate build number to write for surfer. Defaults to 1.")
  parser.add_argument(
      "--surfer-json",
      type=pathlib.Path,
      default=pathlib.Path("surfer.json"),
      help="Path to surfer.json. Defaults to ./surfer.json.")
  args = parser.parse_args()

  if args.latest == bool(args.version):
    parser.error("Provide exactly one of --version or --latest.")

  version = latest_version_for(args.channel) if args.latest else args.version
  update_surfer_json(args.surfer_json, args.channel, version, args.candidate_build)
  print(f"Selected Firefox {args.channel} {version} in {args.surfer_json}")
  print("Next steps: npm run download, then npm run import -- --verbose")


if __name__ == "__main__":
  main()
