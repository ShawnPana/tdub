# terminum ZDOTDIR shim. Runs for every zsh spawned inside terminum
# (shell, tmux panes). Source the user's real config first so their
# environment is unchanged, then ensure $TERMINUM_BIN stays on PATH —
# macOS path_helper (invoked from /etc/zprofile) otherwise wipes it on
# login shells.
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
[[ -n "$TERMINUM_BIN" ]] && export PATH="$TERMINUM_BIN:$PATH"
