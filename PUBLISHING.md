# Publishing ingenue to GitHub

The installer + README point at `github.com/seajaysec/ingenue`. To make the
one-line install work for everyone:

```bash
# from this repo root
gh repo create seajaysec/ingenue --public --source=. --remote=origin --push
# or, manually:
#   git remote add origin git@github.com:seajaysec/ingenue.git
#   git push -u origin main
```

Then add the screenshots (in `screenshots/`) — drop the PNGs captured from the
running app (editor / params / repo / mods / themes) and `git push`.

The installer fetches `web/` from the `main` branch, so anything committed there
ships to users. Override the repo with `INGENUE_REPO=...` when testing a fork.
