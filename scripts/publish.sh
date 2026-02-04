#!/usr/bin/env bash
set -euo pipefail

# Publish script for @talhaorak/council-of-elrond
# Usage:
#   ./scripts/publish.sh          # Auto-increment patch (0.1.0 → 0.1.1)
#   ./scripts/publish.sh 0.2.0    # Use specific version
#   ./scripts/publish.sh minor    # Bump minor (0.1.1 → 0.2.0)
#   ./scripts/publish.sh major    # Bump major (0.2.0 → 1.0.0)

cd "$(dirname "$0")/.."

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Determine new version
if [[ -z "${1:-}" ]]; then
  # No argument: bump patch
  NEW_VERSION=$(node -p "const v='$CURRENT_VERSION'.split('.'); v[2]=parseInt(v[2])+1; v.join('.')")
elif [[ "$1" == "patch" ]]; then
  NEW_VERSION=$(node -p "const v='$CURRENT_VERSION'.split('.'); v[2]=parseInt(v[2])+1; v.join('.')")
elif [[ "$1" == "minor" ]]; then
  NEW_VERSION=$(node -p "const v='$CURRENT_VERSION'.split('.'); v[1]=parseInt(v[1])+1; v[2]=0; v.join('.')")
elif [[ "$1" == "major" ]]; then
  NEW_VERSION=$(node -p "const v='$CURRENT_VERSION'.split('.'); v[0]=parseInt(v[0])+1; v[1]=0; v[2]=0; v.join('.')")
else
  # Explicit version given
  NEW_VERSION="$1"
fi

echo "New version: $NEW_VERSION"

# Confirm
read -p "Publish v$NEW_VERSION? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

# Update package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Updated package.json"

# Build
echo "Building..."
bun run build

# Commit and tag
git add package.json
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

# Push
echo "Pushing to origin..."
git push
git push origin "v$NEW_VERSION"

echo ""
echo "✅ Done! GitHub Actions will publish to npm automatically."
echo "   Watch: https://github.com/talhaorak/council-of-elrond/actions"
