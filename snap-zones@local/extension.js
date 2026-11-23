/*
 * Snap Zones
 *
 * Hold Shift while dragging a window and the screen splits into columns;
 * release the mouse button to drop the window into the highlighted one. Keep
 * the window over a column for a moment and that column divides into a top and
 * a bottom half to drop into instead.
 *
 * The extension only watches drags that Muffin (Cinnamon's window manager) is
 * already running. It never grabs input itself, so with Shift up a drag behaves
 * exactly as it does without the extension.
 */

const { Clutter, GLib, GObject, Meta, St } = imports.gi;
const Main = imports.ui.main;
const Settings = imports.ui.settings;

// Muffin gives Shift a meaning of its own during a window move: it switches
// edge tiling off and snaps the window to nearby edges instead. The first half
// is what keeps the built-in half/quarter tiling out of the way while zones are
// showing. The second half makes the real window hop between edges rather than
// follow the pointer, which is why a stand-in is drawn under the pointer for as
// long as zones are showing (see DragSession._showGhost).
const ACTIVATOR = Clutter.ModifierType.SHIFT_MASK;

// Shift and the mouse button are rarely released in a reliable order, so a drop
// this soon after Shift went up still counts. The zones fade out over the same
// time, which makes "zones still visible" and "drop will snap" the same thing.
const RELEASE_GRACE_MS = 150;
const FADE_IN_MS = 100;

// Pointer travel needed before zones can appear, so that a Shift+click on a
// title bar is not taken for a drop.
const DRAG_THRESHOLD = 12;

const DEFAULT_WEIGHTS = [1, 1, 1];
const MAX_COLUMNS = 12;

// How long the pointer has to stay in a column before the column divides into
// a top and a bottom half. The "split-delay" setting overrides it; 0 means
// columns never divide.
const DEFAULT_SPLIT_SECONDS = 2;

// Space between a zone's edge and its outline, so neighbours stay distinct.
const OUTLINE_INSET = 6;
const BACKDROP_STYLE = 'background-color: rgba(16, 20, 28, 0.28);';
const ZONE_STYLE = 'border-radius: 10px;' +
    'border: 2px solid rgba(255, 255, 255, 0.55);' +
    'background-color: rgba(255, 255, 255, 0.04);';
const TARGET_STYLE = 'border-radius: 10px;' +
    'border: 3px solid rgba(160, 205, 255, 0.95);' +
    'background-color: rgba(53, 132, 228, 0.35);';
const CUE_STYLE = 'background-color: rgba(160, 205, 255, 0.95);';
const CUE_THICKNESS = 2;

// While a window's stand-in is showing, this sits on the real window's actor
// and lets it be painted only through clones of it. An actor with an enabled
// effect is also left out of Muffin's occlusion culling, so whatever is
// underneath the unseen window keeps being drawn. Hiding the actor or zeroing
// its opacity does neither reliably: Muffin re-shows window actors whenever a
// window effect ends, and its culling ignores a window actor's opacity.
//
// GObject type names are global and permanent, and Cinnamon evaluates this file
// again every time the extension is switched on, so each load registers the
// class under a name of its own.
const CloneOnlyEffect = GObject.registerClass({
    GTypeName: `SnapZonesCloneOnlyEffect_${GLib.get_monotonic_time()}`,
}, class CloneOnlyEffect extends Clutter.Effect {
    vfunc_paint(paintContext) {
        let actor = this.get_actor();
        if (actor && actor.is_in_clone_paint())
            actor.continue_paint(paintContext);
    }
});

function monotonicMs() {
    return GLib.get_monotonic_time() / 1000;
}

function parseColumns(text) {
    let weights = String(text).split(/[^0-9.]+/).map(parseFloat)
        .filter(weight => weight > 0 && isFinite(weight));
    return weights.length >= 1 && weights.length <= MAX_COLUMNS ? weights : DEFAULT_WEIGHTS;
}

// Splits a work area into side-by-side rectangles, `gap` pixels apart and
// `gap` pixels from the area's edges. Boundaries are rounded from running
// totals so the columns always add up to exactly the available width.
function layoutZones(area, weights, gap) {
    let total = weights.reduce((sum, weight) => sum + weight, 0);
    let usable = area.width - gap * (weights.length + 1);
    let zones = [];
    let before = 0;
    for (let i = 0; i < weights.length; i++) {
        let left = Math.round(usable * before / total);
        before += weights[i];
        let right = Math.round(usable * before / total);
        zones.push({
            x: area.x + gap * (i + 1) + left,
            y: area.y + gap,
            width: right - left,
            height: area.height - 2 * gap,
        });
    }
    return zones;
}

// Every horizontal position belongs to a zone, including the gaps and anything
// outside the work area such as a panel.
function zoneIndexAt(zones, x) {
    for (let i = 0; i < zones.length - 1; i++) {
        let boundary = (zones[i].x + zones[i].width + zones[i + 1].x) / 2;
        if (x < boundary)
            return i;
    }
    return zones.length - 1;
}

// A zone's top and bottom halves, `gap` pixels apart. A window that comes out
// shorter than its half sits against the seam between the two, so that two
// stacked windows always touch; that is the bottom edge for the upper half.
function splitZone(zone, gap) {
    let top = Math.round((zone.height - gap) / 2);
    return [
        { x: zone.x, y: zone.y, width: zone.width, height: top, anchorBottom: true },
        { x: zone.x, y: zone.y + top + gap, width: zone.width, height: zone.height - top - gap },
    ];
}

function halfIndexAt(halves, y) {
    let boundary = (halves[0].y + halves[0].height + halves[1].y) / 2;
    return y < boundary ? 0 : 1;
}

// Maximized and tiled windows stay put when a drag starts; Muffin pulls them
// loose once the pointer has travelled far enough.
function isPinned(window) {
    return window.get_maximized() !== 0 || window.tile_mode !== Meta.TileMode.NONE;
}

// If the pointer is resting on a screen edge when Shift goes down, Cinnamon's
// own tile preview is up, and Muffin only takes it down on the next pointer
// motion.
function hideTilePreview() {
    let wm = Main.wm;
    if (wm && typeof wm._hideTilePreview === 'function')
        wm._hideTilePreview();
}

function placeWindow(window, zone, area) {
    // Normally the window is floating by now. It is tiled if the pointer was
    // parked on a screen edge, with Cinnamon's tile preview up, when Shift went
    // down: Muffin then tiles on release and would pin the window there.
    if (isPinned(window))
        window.unmaximize(Meta.MaximizeFlags.BOTH);

    // Go to the zone first, then take its size. Not every window can be given
    // exactly the size asked for: terminals grow in whole character cells, and
    // some windows have a minimum size larger than the zone. Muffin sizes those
    // from wherever they currently are and drops the requested position, and at
    // the end of a Shift-drag that is whichever edge Muffin last snapped the
    // window to.
    window.move_frame(true, zone.x, zone.y);
    window.move_resize_frame(true, zone.x, zone.y, zone.width, zone.height);

    // A Wayland client only takes its new size once it has acknowledged it, so
    // what the window ended up with cannot be read back here.
    if (Meta.is_wayland_compositor())
        return;

    // Now that the real size is known, decide where a window that did not fit
    // exactly goes: fixed-size ones to the middle, shorter ones against the
    // zone's top edge (or the seam of a divided column), larger ones as far
    // into the zone as the work area allows.
    let frame = window.get_frame_rect();
    let x = zone.x;
    let y = zone.y;
    if (!window.allows_resize()) {
        x += Math.round((zone.width - frame.width) / 2);
        y += Math.round((zone.height - frame.height) / 2);
    } else if (zone.anchorBottom) {
        y += zone.height - frame.height;
    }
    x = Math.max(area.x, Math.min(x, area.x + area.width - frame.width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - frame.height));
    if (x !== frame.x || y !== frame.y)
        window.move_frame(true, x, y);
}

// What a drag shows on top of the windows: dimmed surroundings at the bottom,
// zone outlines at the top, and room for the window's stand-in in between.
class ZoneOverlay {
    constructor() {
        this.actor = new Clutter.Actor({ reactive: false });
        this._backdrop = new St.Bin({ style: BACKDROP_STYLE, reactive: false, opacity: 0 });
        this._outlines = new Clutter.Actor({ reactive: false, opacity: 0 });
        this._tileBox = new Clutter.Actor({ reactive: false });
        // A line that grows from the middle of a column out to its sides while
        // the pointer waits there, and reaches them as the column divides.
        this._cue = new St.Bin({ style: CUE_STYLE, reactive: false, visible: false });
        this._cue.set_pivot_point(0.5, 0.5);
        this._outlines.add_child(this._tileBox);
        this._outlines.add_child(this._cue);
        this.actor.add_child(this._backdrop);
        this.actor.add_child(this._outlines);
        this._tiles = [];
        this._target = -1;
        this._shown = false;

        // Above every window, below panels and menus.
        global.overlay_group.add_child(this.actor);
    }

    destroy() {
        this.actor.destroy();
    }

    addGhost(ghost) {
        this.actor.insert_child_above(ghost, this._backdrop);
    }

    setZones(area, zones) {
        this._backdrop.set_position(area.x, area.y);
        this._backdrop.set_size(area.width, area.height);

        let inset = Math.round(OUTLINE_INSET * global.ui_scale);
        this._tileBox.destroy_all_children();
        this._tiles = zones.map(zone => {
            let tile = new St.Bin({ style: ZONE_STYLE, reactive: false });
            tile.set_position(zone.x + inset, zone.y + inset);
            tile.set_size(Math.max(1, zone.width - 2 * inset), Math.max(1, zone.height - 2 * inset));
            this._tileBox.add_child(tile);
            return tile;
        });
        this._target = -1;
    }

    // Shows how much of the wait before `zone` divides has passed, from 0 to 1.
    // The line is drawn where the two halves will meet. 0 hides it.
    setSplitProgress(zone, gap, fraction) {
        if (!(fraction > 0)) {
            this._cue.hide();
            return;
        }
        let inset = Math.round(OUTLINE_INSET * global.ui_scale);
        let thickness = Math.max(1, Math.round(CUE_THICKNESS * global.ui_scale));
        let halves = splitZone(zone, gap);
        let seam = (halves[0].y + halves[0].height + halves[1].y) / 2;
        this._cue.set_position(zone.x + inset, Math.round(seam - thickness / 2));
        this._cue.set_size(Math.max(1, zone.width - 2 * inset), thickness);
        this._cue.scale_x = Math.min(fraction, 1);
        this._cue.show();
    }

    setTarget(index) {
        if (index === this._target)
            return;
        if (this._tiles[this._target])
            this._tiles[this._target].style = ZONE_STYLE;
        if (this._tiles[index])
            this._tiles[index].style = TARGET_STYLE;
        this._target = index;
    }

    setShown(shown) {
        if (shown === this._shown)
            return;
        this._shown = shown;
        for (let actor of [this._backdrop, this._outlines]) {
            actor.remove_all_transitions();
            actor.ease({
                opacity: shown ? 255 : 0,
                duration: shown ? FADE_IN_MS : RELEASE_GRACE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }
}

// Follows one window move from grab-op-begin to grab-op-end.
class DragSession {
    constructor(window, config) {
        this.window = window;
        this._config = config;
        this._actor = window.get_compositor_private();
        this._overlay = null;
        this._ghost = null;
        this._hideEffect = null;
        this._zones = [];
        this._area = null;
        this._monitor = -1;
        this._zonesUp = false;
        // The column the pointer is over, since when, and whether it has
        // divided into halves.
        this._column = -1;
        this._columnSince = 0;
        this._split = false;
        this._outlined = null;
        this._lastHeld = -Infinity;
        this._moved = false;

        let [x, y] = global.get_pointer();
        let frame = window.get_frame_rect();
        this._startX = x;
        this._startY = y;
        // Where on the window the pointer is holding it: an ordinary drag keeps
        // the window's corner this far from the pointer. Refined by
        // _trackWindow as the drag goes on.
        this._grabX = x - frame.x;
        this._grabY = y - frame.y;
        this._frameX = frame.x;
        this._frameY = frame.y;
        this._pinned = isPinned(window);

        this._movedId = window.connect('position-changed', () => this._onWindowMoved());
        if (this._actor)
            this._actorDestroyId = this._actor.connect('destroy', () => this._onActorDestroyed());

        // A window move has the compositor redrawing every frame anyway; a
        // timeline looks at the pointer once per frame, after input has been
        // handled and before the frame is painted.
        this._timeline = new Clutter.Timeline({ duration: 1000 * 1000 });
        this._timeline.set_repeat_count(-1);
        this._timeline.connect('new-frame', () => this._onFrame());
        this._timeline.start();
    }

    // Ends the session and returns where to drop the window, or null.
    finish() {
        let drop = null;
        try {
            if (this._actor) {
                let pointer = this._readPointer();
                // Escape ends a drag while the button is still down, and Muffin
                // has already put the window back where it started.
                let cancelled = (pointer.mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
                if (pointer.zonesWanted && !cancelled) {
                    this._updateZones();
                    drop = { zone: this._dropZone(pointer), area: this._area };
                }
            }
        } catch (e) {
            global.logError('snap-zones: could not work out the drop target', e);
        }
        this.destroy();
        return drop;
    }

    destroy() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }
        this._removeGhost();
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        if (this._movedId) {
            this.window.disconnect(this._movedId);
            this._movedId = 0;
        }
        if (this._actor && this._actorDestroyId)
            this._actor.disconnect(this._actorDestroyId);
        this._actorDestroyId = 0;
        this._actor = null;
    }

    _onActorDestroyed() {
        // The window closed mid-drag; its actor takes the effect with it.
        this._actorDestroyId = 0;
        this._actor = null;
        this.destroy();
    }

    _onFrame() {
        try {
            this._update();
        } catch (e) {
            global.logError('snap-zones: giving up on this drag', e);
            this.destroy();
        }
    }

    _onWindowMoved() {
        try {
            if (this._actor)
                this._trackWindow(Clutter.get_current_event());
        } catch (e) {
            global.logError('snap-zones: giving up on this drag', e);
            this.destroy();
        }
    }

    // Keeps the grab point exact. Called every frame, and with the event being
    // handled whenever the window moves.
    _trackWindow(event) {
        let frame = this.window.get_frame_rect();
        let pinned = isPinned(this.window);

        if (this._pinned && !pinned) {
            // Pulled loose: the window reappears at its remembered size
            // somewhere under the pointer, and Muffin goes on measuring pointer
            // travel from where the drag began. The grab point shifts by as
            // much as the window's corner did.
            this._grabX += this._frameX - frame.x;
            this._grabY += this._frameY - frame.y;
        } else if (!pinned && event && event.type() === Clutter.EventType.MOTION &&
                   (event.get_state() & ACTIVATOR) === 0) {
            // Muffin has just moved the window for this pointer motion, so the
            // two are in step. Asking the X server where the pointer is would
            // give a position up to a frame ahead of the window.
            let [x, y] = event.get_coords();
            this._grabX = x - frame.x;
            this._grabY = y - frame.y;
        }

        this._pinned = pinned;
        this._frameX = frame.x;
        this._frameY = frame.y;
    }

    _readPointer() {
        let [x, y, mods] = global.get_pointer();
        if (!this._moved) {
            let threshold = DRAG_THRESHOLD * global.ui_scale;
            this._moved = Math.abs(x - this._startX) >= threshold || Math.abs(y - this._startY) >= threshold;
        }
        let held = this._moved && (mods & ACTIVATOR) !== 0;
        let now = monotonicMs();
        if (held)
            this._lastHeld = now;
        return { x, y, mods, held, zonesWanted: held || now - this._lastHeld <= RELEASE_GRACE_MS };
    }

    _update() {
        if (!this._actor)
            return;

        this._trackWindow(null);
        let pointer = this._readPointer();

        if (pointer.zonesWanted) {
            if (!this._zonesUp)
                hideTilePreview();
            this._updateZones();
            this._dwell(pointer);
            this._showZones(pointer);
            this._overlay.setShown(pointer.held);
            this._showGhost(pointer);
            this._zonesUp = true;
        } else if (this._zonesUp) {
            // Shift went up and the drag carries on. The real window may still
            // be parked on whatever edge Muffin last snapped it to, so put it
            // where the stand-in has been showing it before swapping back.
            this.window.move_frame(true, pointer.x - this._grabX, pointer.y - this._grabY);
            this._removeGhost();
            this._zonesUp = false;
            // With the zones gone, so is any wait for a column to divide.
            this._column = -1;
            this._split = false;
        }
    }

    _updateZones() {
        if (!this._overlay)
            this._overlay = new ZoneOverlay();

        let monitor = global.display.get_current_monitor();
        if (monitor < 0)
            monitor = this.window.get_monitor();
        if (monitor === this._monitor)
            return;

        this._monitor = monitor;
        this._area = this.window.get_work_area_for_monitor(monitor);
        this._zones = layoutZones(this._area, this._config.weights, this._config.gap);
        // Another screen's columns: nothing about the old one carries over.
        this._column = -1;
        this._split = false;
        this._outlined = null;
    }

    // Notes which column the pointer is over, and divides it once the pointer
    // has stayed there long enough. Entering another column starts the wait
    // again, and the column left behind is whole the next time round.
    _dwell(pointer) {
        let now = monotonicMs();
        let column = zoneIndexAt(this._zones, pointer.x);
        if (column !== this._column) {
            this._column = column;
            this._columnSince = now;
            this._split = false;
        } else if (!this._split && this._config.splitDelay > 0 &&
                   now - this._columnSince >= this._config.splitDelay) {
            this._split = true;
        }
    }

    // Where a drop at the pointer lands: a column, or one half of the column
    // that is showing as divided.
    _dropZone(pointer) {
        let column = zoneIndexAt(this._zones, pointer.x);
        let zone = this._zones[column];
        if (!this._split || column !== this._column)
            return zone;
        let halves = splitZone(zone, this._config.gap);
        return halves[halfIndexAt(halves, pointer.y)];
    }

    _showZones(pointer) {
        let column = this._zones[this._column];
        let outlines = this._zones;
        let target = this._column;
        if (this._split) {
            let halves = splitZone(column, this._config.gap);
            outlines = this._zones.slice();
            outlines.splice(this._column, 1, ...halves);
            target += halfIndexAt(halves, pointer.y);
        }

        // The outlines are only rebuilt when their arrangement changes.
        let outlined = `${this._monitor}:${this._split ? this._column : 'whole'}`;
        if (outlined !== this._outlined) {
            this._overlay.setZones(this._area, outlines);
            this._outlined = outlined;
        }
        this._overlay.setTarget(target);

        let waiting = !this._split && this._config.splitDelay > 0;
        this._overlay.setSplitProgress(column, this._config.gap,
            waiting ? (monotonicMs() - this._columnSince) / this._config.splitDelay : 0);
    }

    // While zones are showing, the real window goes unpainted and a clone of
    // it is drawn where an ordinary drag would have it.
    _showGhost(pointer) {
        if (!this._ghost) {
            this._ghost = new Clutter.Clone({ source: this._actor, reactive: false });
            this._overlay.addGhost(this._ghost);
            this._hideEffect = new CloneOnlyEffect();
            this._actor.add_effect(this._hideEffect);
        }
        // The actor is larger than the frame: it includes shadows and the
        // invisible resize borders.
        this._ghost.set_position(
            pointer.x - this._grabX + this._actor.x - this._frameX,
            pointer.y - this._grabY + this._actor.y - this._frameY);
    }

    _removeGhost() {
        if (!this._ghost)
            return;
        this._ghost.destroy();
        this._ghost = null;
        if (this._actor)
            this._actor.remove_effect(this._hideEffect);
        this._hideEffect = null;
    }
}

class SnapZones {
    constructor(uuid) {
        this._drag = null;
        this._config = { weights: DEFAULT_WEIGHTS, gap: 0, splitDelay: DEFAULT_SPLIT_SECONDS * 1000 };

        this._settings = new Settings.ExtensionSettings(this, uuid);
        this._settings.bind('columns', 'columnsSetting', this._readSettings);
        this._settings.bind('gap', 'gapSetting', this._readSettings);
        this._settings.bind('split-delay', 'splitDelaySetting', this._readSettings);
        this._readSettings();

        // The window and the operation are the last arguments on every Muffin
        // version; older ones pass an extra object before them.
        this._beginId = global.display.connect('grab-op-begin',
            (display, ...args) => this._onGrabBegin(args));
        this._endId = global.display.connect('grab-op-end',
            () => this._onGrabEnd());
    }

    destroy() {
        global.display.disconnect(this._beginId);
        global.display.disconnect(this._endId);
        this._abandonDrag();
        this._settings.finalize();
    }

    _readSettings() {
        // Replaced rather than modified, so a drag in progress keeps the layout
        // it started with.
        let splitSeconds = Number(this.splitDelaySetting);
        if (!isFinite(splitSeconds))
            splitSeconds = DEFAULT_SPLIT_SECONDS;
        this._config = {
            weights: parseColumns(this.columnsSetting),
            gap: Math.max(0, Math.round(Number(this.gapSetting) || 0)),
            splitDelay: Math.max(0, splitSeconds) * 1000,
        };
    }

    _onGrabBegin(args) {
        this._abandonDrag();

        let op = args[args.length - 1];
        let window = args.find(arg => arg instanceof Meta.Window);
        // Only pointer drags: moves started from the keyboard or the window
        // menu are a different operation.
        if (op !== Meta.GrabOp.MOVING || !window)
            return;

        try {
            this._drag = new DragSession(window, this._config);
        } catch (e) {
            global.logError('snap-zones: could not follow this drag', e);
        }
    }

    _onGrabEnd() {
        let drag = this._drag;
        if (!drag)
            return;
        this._drag = null;

        let drop = drag.finish();
        if (!drop)
            return;
        try {
            placeWindow(drag.window, drop.zone, drop.area);
        } catch (e) {
            global.logError('snap-zones: could not place the window', e);
        }
    }

    _abandonDrag() {
        if (this._drag) {
            this._drag.destroy();
            this._drag = null;
        }
    }
}

let uuid = null;
let snapZones = null;

function init(metadata) {
    uuid = metadata.uuid;
}

function enable() {
    snapZones = new SnapZones(uuid);
}

function disable() {
    if (snapZones) {
        snapZones.destroy();
        snapZones = null;
    }
}
