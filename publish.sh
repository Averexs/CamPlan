#!/usr/bin/env bash
# Usage: ./publish.sh YOUR_GITHUB_USERNAME [repo-name]
# Fills in your username, commits, and pushes to GitHub (creates the repo if the GitHub CLI "gh" is installed).
set -e
USER_LC=$(echo "${1:?Usage: ./publish.sh GITHUB_USERNAME [repo-name]}" | tr '[:upper:]' '[:lower:]')
REPO=$(echo "${2:-camplan}" | tr '[:upper:]' '[:lower:]')
sed -i.bak "s#ghcr.io/YOUR_GITHUB_USERNAME/camplan#ghcr.io/$USER_LC/$REPO#g; s#YOUR_GITHUB_USERNAME/camplan#$USER_LC/$REPO#g" docker-compose.yml README.md
rm -f docker-compose.yml.bak README.md.bak
[ -d .git ] || git init -q
git add . && git commit -qm "Initial release" || true
git branch -M main
if command -v gh >/dev/null 2>&1; then
  gh repo create "$USER_LC/$REPO" --public --source=. --remote=origin --push
else
  git remote add origin "https://github.com/$USER_LC/$REPO.git" 2>/dev/null || true
  echo "Create an empty repo named $REPO on GitHub first, then press Enter to push."; read -r
  git push -u origin main
fi
echo "Done. Watch the build at https://github.com/$USER_LC/$REPO/actions"
echo "Then set the package to Public: https://github.com/users/$USER_LC/packages/container/$REPO/settings"
