// Copyright (c) 2026, h.halai0334@gmail.com and contributors
// For license information, please see license.txt

// Mounts the label preview on the form and re-renders it whenever anything that affects
// the printed result changes. The panel itself lives in public/js/label_preview.js and is
// loaded through the doctype_js hook.

// Only a field marked in_list_view is editable by clicking its cell in the grid;
// everything else is reachable solely through the row editor. The doctype marks these, but
// that only reaches a site once the doctype itself reloads, so they are applied here too.
// Once the doctype has caught up this becomes a no-op, and a user who has chosen their own
// columns from the grid's settings keeps them either way.
const GRID_COLUMNS = { item_select: 2, item_text: 4, item_x: 1, item_y: 1, font_size: 2 };

frappe.ui.form.on("Discount Labels", {
	refresh(frm) {
		ensure_grid_columns(frm);
		mount_preview(frm);
		frm.add_custom_button(__("Preview Label"), () => {
			// This file is loaded straight from the doctype folder, but the panel comes in
			// through the doctype_js hook. The two can be out of step - a stale hook cache
			// leaves this button on a form with nothing behind it - so say what is wrong
			// rather than throwing a ReferenceError at whoever clicks.
			if (!assets_loaded()) {
				frappe.msgprint({
					title: __("Label preview not loaded"),
					indicator: "orange",
					message: __(
						"The preview scripts did not load. On the server, run <code>bench --site &lt;site&gt; clear-cache</code> and <code>bench restart</code>, then reload this page."
					),
				});
				return;
			}
			warehouse_management.show_label_preview_dialog(frm);
		});
	},

	label_width: refresh_preview,
	label_height: refresh_preview,
	label_gap: refresh_preview,

	is_label_discount(frm) {
		// The discount placeholders only resolve on a discount label, and the sample
		// data panel grows a discount section, so rebuild rather than redraw.
		if (frm.label_preview) frm.label_preview.buildSampleForm();
		refresh_preview(frm);
	},

	item_table_add: refresh_preview,
	item_table_remove: refresh_preview,
	item_table_move: refresh_preview,
});

// Every child field feeds the TSPL output, so they all trigger a redraw.
frappe.ui.form.on("Discount Label Items", {
	item_select: refresh_preview,
	item_text: refresh_preview,
	item_image: refresh_preview,
	image_width: refresh_preview,
	image_height: refresh_preview,
	limit: refresh_preview,
	line_limit: refresh_preview,
	wrap_offset: refresh_preview,
	item_x: refresh_preview,
	item_y: refresh_preview,
	font_size: refresh_preview,
	font_name: refresh_preview,
});

// The three modules behind the panel arrive via the doctype_js hook in hooks.py. That
// hook is cached server side, so after it changes the site needs its cache cleared and the
// process restarted before they appear.
function assets_loaded() {
	return !!(
		window.warehouse_management &&
		warehouse_management.LabelPreview &&
		warehouse_management.tspl &&
		warehouse_management.barcode
	);
}

function ensure_grid_columns(frm) {
	const field = frm.fields_dict.item_table;
	const grid = field && field.grid;
	if (!grid || !grid.docfields) return;

	// Columns the user picked themselves win; this is only a default.
	if (grid.user_defined_columns && grid.user_defined_columns.length) return;

	let changed = false;
	Object.keys(GRID_COLUMNS).forEach((fieldname) => {
		const df = grid.docfields.find((d) => d.fieldname === fieldname);
		if (!df || df.in_list_view) return;
		try {
			grid.update_docfield_property(fieldname, "in_list_view", 1);
			grid.update_docfield_property(fieldname, "columns", GRID_COLUMNS[fieldname]);
			changed = true;
		} catch (e) {
			// This site's doctype does not have the field yet; nothing to widen.
		}
	});

	if (!changed) return;
	// setup_visible_columns caches its result and refresh() does not clear it, so the new
	// columns only appear once that cache is dropped.
	grid.visible_columns = null;
	grid.refresh();
}

function mount_preview(frm) {
	const field = frm.fields_dict.label_preview;
	if (!field) return;
	if (!assets_loaded()) {
		field.$wrapper.html(
			`<div class="text-muted">${__(
				"The label preview scripts did not load. On the server, run <code>bench --site &lt;site&gt; clear-cache</code> and <code>bench restart</code>, then reload this page."
			)}</div>`
		);
		return;
	}
	// Frappe calls refresh on load, after every save and on any frm.refresh(). Building a
	// new panel each time would re-read App Settings over the wire and throw away the
	// zoom, the scroll position and the open TSPL panel, so reuse the one already there.
	if (frm.label_preview && frm.label_preview.isMountedOn(field.$wrapper)) {
		frm.label_preview.refresh();
		return;
	}

	frm.label_preview = new warehouse_management.LabelPreview({
		frm: frm,
		wrapper: field.$wrapper,
	});
}

function refresh_preview(frm) {
	if (frm.label_preview) frm.label_preview.refresh();
}
