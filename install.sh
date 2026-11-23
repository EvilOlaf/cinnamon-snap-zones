#!/bin/bash
# Installs the Snap Zones extension for the current user and switches it on.
#
#   ./install.sh            install or update, then enable
#   ./install.sh --remove   disable and delete
#
# Nothing here needs root, and Cinnamon picks the change up without a restart.
set -euo pipefail

UUID="snap-zones@local"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/extensions/$UUID"

# The system tools, by full path: a gsettings from Homebrew earlier in PATH does
# not use dconf, so it neither sees nor changes Cinnamon's real settings.
GSETTINGS=/usr/bin/gsettings
DBUS_SEND=/usr/bin/dbus-send
[ -x "$GSETTINGS" ] || GSETTINGS=gsettings
[ -x "$DBUS_SEND" ] || DBUS_SEND=dbus-send

enabled_list() {
    "$GSETTINGS" get org.cinnamon enabled-extensions
}

cinnamon_call() {
    "$DBUS_SEND" --session --print-reply --dest=org.Cinnamon /org/Cinnamon "org.Cinnamon.$1" "${@:2}"
}

is_running() {
    cinnamon_call GetRunningXletUUIDs string:extension 2>/dev/null | grep -qF "\"$UUID\""
}

if [ "${1:-}" = "--remove" ]; then
    current="$(enabled_list)"
    case "$current" in
        "['$UUID']")   "$GSETTINGS" set org.cinnamon enabled-extensions "@as []" ;;
        *"'$UUID', "*) "$GSETTINGS" set org.cinnamon enabled-extensions "${current/"'$UUID', "/}" ;;
        *", '$UUID'"*) "$GSETTINGS" set org.cinnamon enabled-extensions "${current/", '$UUID'"/}" ;;
    esac
    rm -rf -- "$DEST"
    echo "Snap Zones is disabled and removed."
    exit 0
fi

[ -f "$SRC/extension.js" ] || { echo "Cannot find $SRC/extension.js" >&2; exit 1; }

mkdir -p "$DEST"
cp -- "$SRC/extension.js" "$SRC/metadata.json" "$SRC/settings-schema.json" "$DEST/"

current="$(enabled_list)"
case "$current" in
    *"'$UUID'"*)
        # Already on: this is an update, so have Cinnamon load the new files.
        cinnamon_call ReloadXlet "string:$UUID" string:EXTENSION >/dev/null 2>&1 || true
        ;;
    "@as []")
        "$GSETTINGS" set org.cinnamon enabled-extensions "['$UUID']"
        ;;
    *)
        "$GSETTINGS" set org.cinnamon enabled-extensions "${current%]}, '$UUID']"
        ;;
esac

for _ in 1 2 3 4 5 6 7 8 9 10; do
    if is_running; then
        echo "Snap Zones is running. Hold Shift while dragging a window to try it."
        exit 0
    fi
    sleep 0.3
done

echo "Installed to $DEST and enabled, but Cinnamon does not report it as running." >&2
echo "Look for 'snap-zones' in Looking Glass (Alt+F2, lg, Enter) or in ~/.xsession-errors." >&2
exit 1
