"""Which files of a Caesar III folder Augustus needs.

Used by server.py. Keep in sync with SKIP_RE in shell.html.
"""
import fnmatch
import os

# Installers, Windows binaries, manuals and what GOG and uninstallers leave.
SKIP = ["*.exe", "*.dll", "*.pdf", "*.lnk", "*.url", "*.ico", "*.log", "*.tmp",
        "unins*", "goggame*"]
SKIP_DIRS = {"__support", "__redist"}
# One of these marks the folder with the game in it.
MARKERS = {"c3.sg2", "c3.eng"}


def problem(game_dir):
    """Why game_dir cannot be served, or None when the game is in it."""
    # The game may sit one folder down, e.g. in "Caesar 3" of a GOG folder.
    folders = [game_dir]
    try:
        folders += [entry.path for entry in os.scandir(game_dir) if entry.is_dir()]
    except OSError:
        folders = []
    for folder in folders:
        try:
            if MARKERS & {name.lower() for name in os.listdir(folder)}:
                return None
        except OSError:
            pass
    return "No Caesar III files (c3.sg2, c3.eng)"


def needed(rel_parts):
    """Whether a file (path parts relative to the game folder) is needed."""
    name = rel_parts[-1].lower()
    if any(d.lower() in SKIP_DIRS for d in rel_parts[:-1]):
        return False
    return not any(fnmatch.fnmatchcase(name, pattern) for pattern in SKIP)


def walk_needed(game_dir, app_dir=None):
    """Yields (parts, full_path) for every needed file of the game folder.

    game_dir is None when the browsers bring their own game folder; Augustus
    adds nothing to it, so there is nothing to offer then.
    """
    if not game_dir:
        return
    for root, dirs, files in os.walk(game_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        rel_root = os.path.relpath(root, game_dir)
        for name in sorted(files):
            if name.startswith("."):
                continue
            parts = [] if rel_root == "." else rel_root.split(os.sep)
            parts.append(name)
            if needed(parts):
                yield parts, os.path.join(root, name)
