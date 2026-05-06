#!/bin/sh
set -e
cd /Users/deepak/Desktop/GAPP
git status --short > /Users/deepak/Desktop/GAPP/_git_out.txt 2>&1
git remote -v >> /Users/deepak/Desktop/GAPP/_git_out.txt 2>&1
echo "---" >> /Users/deepak/Desktop/GAPP/_git_out.txt
git diff --stat >> /Users/deepak/Desktop/GAPP/_git_out.txt 2>&1 || true
