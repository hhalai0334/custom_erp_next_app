// Copyright (c) 2026, h.halai0334@gmail.com and contributors
// For license information, please see license.txt
//
// The Discount Labels preview panel.
//
// It draws the label at the printer's own resolution - one canvas pixel per printer dot -
// and then upscales with nearest-neighbour, so what you see has the same geometry the TSC
// head produces. Text is thresholded to pure black and white because the printer is a
// one-bit device: a font that looks fine antialiased can come out broken at 8x12 dots, and
// the preview should show that rather than hide it.
//
// Sample data is editable and kept in localStorage, so a layout can be checked against a
// long product name or a five-digit price without touching a real item.

frappe.provide("warehouse_management");

(function () {
	const STORAGE_KEY = "wm_label_preview_v1";

	// The printer's fixed-pitch dot fonts have no web equivalent, so the closest thing is
	// a condensed monospace squeezed into the exact dot cell and then thresholded to one
	// bit. Shapes are approximate; the cell size, spacing and total width are exact.
	const MONO_STACK = '"DejaVu Sans Mono", Consolas, "Liberation Mono", "Courier New", monospace';
	const OCR_STACK = '"OCR A Extended", "OCRB", "DejaVu Sans Mono", Consolas, monospace';
	// Built-in font 0 really is Triumvirate Bold *Condensed*, so a condensed face is the
	// honest stand-in for it.
	const CONDENSED_STACK =
		'"Arial Narrow", "Liberation Sans Narrow", "DejaVu Sans Condensed", sans-serif';
	// A downloaded TTF is whatever the operator put on the printer, and that is normally a
	// regular-width face. Standing in for it with a condensed one draws the row narrower
	// than it prints, which hides text that will actually run off the label.
	const PROPORTIONAL_STACK =
		'Arial, "Liberation Sans", "Helvetica Neue", "Segoe UI", sans-serif';

	// Sample product values, keyed like ErpNextMobile Core.DbModels.Product.
	const DEFAULT_PRODUCT = {
		Id: "ITEM-00042",
		Name: 'Majica pamucna "Classic"',
		Name2: "Cotton T-Shirt",
		Model: "MOD-88",
		Mpn: "MPN-7741",
		// A valid EAN-13, so switching the preview to EAN13 works without editing it.
		Barcode: "3859888123458",
		A1: "Crvena",
		A2: "XL",
		A3: "Pamuk",
		A4: "Ljeto",
		Price: 129.99,
		WholesalePrice: 89.5,
		OldPrice: 159.99,
		Description: "Majica od 100% pamuka, kratki rukav, unisex kroj",
		Description2: "Made in EU",
		Country: "Hrvatska",
		ExternalId: "EXT-55021",
	};

	const DEFAULT_DISCOUNT = {
		Price: 99.99,
		LowestPrice: 94.99,
		StartDate: "2026-09-01",
		EndDate: "2026-09-30",
		DiscountNo: "AKC-2026-07",
	};

	// Only dpi, zoom, oneBit and fontMetrics are preview-side choices. The rest mirror
	// what the mobile app passes to TscCommandBuilder, and are read from App Settings on
	// the server unless the operator overrides them here to try something out.
	const DEFAULT_SETTINGS = {
		dpi: 203,
		zoom: 0,
		oneBit: true,
		fontMetrics: "tspl",
		barcodeType: "128",
		priceFormat: "#.###,##",
		currencyMode: "Symbol",
		currencySymbol: "€",
		currencyName: "EUR",
		printerEncoding: "UTF8",
		custom: false,
	};

	// The server-backed settings at their built-in values, so clearing an override starts
	// from the defaults and not from whatever was last typed in.
	function DEFAULT_SETTINGS_SERVER_SLICE() {
		const slice = {};
		SERVER_BACKED.forEach((k) => (slice[k] = DEFAULT_SETTINGS[k]));
		return slice;
	}

	// Which settings come from App Settings / the currency record rather than from here.
	const SERVER_BACKED = [
		"barcodeType",
		"priceFormat",
		"currencyMode",
		"currencySymbol",
		"currencyName",
		"printerEncoding",
	];

	// Mirrors what the mobile app loads before it builds a label: App Settings for the
	// print options, then the ERPNext currency record for the symbol and name, the same
	// way the sync does. Failures fall back to the built-in defaults rather than taking
	// the preview down - it is a preview, not a print path.
	// App Settings spells the price formats X.xxx,xx while the label code and this panel
	// use #.###,##. PriceFormatter accepts both, but the toolbar select only carries one
	// set, so fold the App Settings spelling onto it or the control renders blank.
	const PRICE_FORMAT_ALIASES = {
		"X.xxx,xx": "#.###,##",
		"Xxxx,xx": "####,##",
		"X,xxxx.xx": "#,###.##",
		"Xxxx.xx": "####.##",
	};

	function normalizePriceFormat(value) {
		return PRICE_FORMAT_ALIASES[value] || value;
	}

	async function fetchServerSettings() {
		const out = {};
		try {
			const app = await frappe.db.get_doc("AppSettings");
			if (app.default_barcode) out.barcodeType = app.default_barcode;
			if (app.default_price_format) {
				out.priceFormat = normalizePriceFormat(app.default_price_format);
			}
			if (app.default_currency) out.currencyMode = app.default_currency;
			if (app.default_encoding) out.printerEncoding = app.default_encoding;
		} catch (e) {
			// No App Settings, or no permission to read it.
		}
		try {
			const code = await frappe.db.get_single_value("Global Defaults", "default_currency");
			if (code) {
				const cur = await frappe.db.get_value("Currency", code, ["symbol", "currency_name"]);
				const row = (cur && cur.message) || {};
				if (row.symbol) out.currencySymbol = row.symbol;
				out.currencyName = row.currency_name || code;
			}
		} catch (e) {
			// Fall back to the euro defaults above.
		}
		return out;
	}

	const PRODUCT_FIELDS = [
		{ key: "Id", label: "Id", type: "text" },
		{ key: "Name", label: "Name", type: "text" },
		{ key: "Name2", label: "Name 2", type: "text" },
		{ key: "Model", label: "Model", type: "text" },
		{ key: "Mpn", label: "MPN", type: "text" },
		{ key: "Barcode", label: "Barcode", type: "text" },
		{ key: "ExternalId", label: "External Id", type: "text" },
		{ key: "A1", label: "A1", type: "text" },
		{ key: "A2", label: "A2 / Size", type: "text" },
		{ key: "A3", label: "A3", type: "text" },
		{ key: "A4", label: "A4", type: "text" },
		{ key: "Price", label: "Price", type: "number" },
		{ key: "WholesalePrice", label: "Wholesale Price", type: "number" },
		{ key: "OldPrice", label: "Old Price", type: "number" },
		{ key: "Country", label: "Country", type: "text" },
		{ key: "Description", label: "Description", type: "text" },
		{ key: "Description2", label: "Description 2", type: "text" },
	];

	const DISCOUNT_FIELDS = [
		{ key: "Price", label: "Discount Price", type: "number" },
		{ key: "LowestPrice", label: "Lowest Price", type: "number" },
		{ key: "StartDate", label: "Start Date", type: "date" },
		{ key: "EndDate", label: "End Date", type: "date" },
		{ key: "DiscountNo", label: "Discount No", type: "text" },
	];

	// Turns a Font Name into something safe to drop inside a quoted CSS family. A stray
	// quote or backslash makes the whole ctx.font shorthand invalid, and an invalid
	// assignment is a silent no-op - the canvas keeps the previous row's font, so the row
	// gets drawn at some other row's size and the preview lies about it. Returns "" when
	// nothing usable is left, so the caller can fall back to the generic stack.
	function cssFamilyName(name) {
		return String(name == null ? "" : name)
			.replace(/\.[^.]+$/, "")
			.replace(/["'\\]/g, "")
			.trim();
	}

	function loadState() {
		let stored = {};
		try {
			stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
		} catch (e) {
			stored = {};
		}
		return {
			settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings || {}),
			product: Object.assign({}, DEFAULT_PRODUCT, stored.product || {}),
			discount: Object.assign({}, DEFAULT_DISCOUNT, stored.discount || {}),
		};
	}

	function saveState(state) {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch (e) {
			// A full or disabled localStorage must not take the preview down with it.
		}
	}

	function injectStyles() {
		if (document.getElementById("wm-label-preview-styles")) return;
		const style = document.createElement("style");
		style.id = "wm-label-preview-styles";
		style.textContent = [
			".wm-lp { font-size: var(--text-sm); }",
			".wm-lp-banner { padding: 7px 11px; margin-bottom: 10px; border-radius: var(--border-radius);",
			"  background: var(--bg-light-gray, #f4f5f6); color: var(--text-muted);",
			"  border-left: 3px solid var(--border-color); font-size: var(--text-xs); }",
			".wm-lp-source { margin-top: 3px; }",
			".wm-lp-source.wm-lp-pinned { color: var(--yellow-600, #b87503); }",
			".wm-lp-toolbar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: flex-end;",
			"  padding: 10px 12px; background: var(--fg-color); border: 1px solid var(--border-color);",
			"  border-radius: var(--border-radius-md); margin-bottom: 12px; }",
			".wm-lp-ctl { display: flex; flex-direction: column; gap: 3px; }",
			".wm-lp-ctl > label { font-size: var(--text-xs); color: var(--text-muted);",
			"  margin: 0; text-transform: uppercase; letter-spacing: .04em; }",
			// Checkboxes are excluded: the desk styles them with a background image, and
			// stretching one to a 28px padded box tiles that image into a striped blob.
			".wm-lp-ctl input[type=\"checkbox\"] { width: 14px; height: 14px; flex: none; margin: 0;",
			"  padding: 0; accent-color: var(--primary, #2490ef); }",
			".wm-lp-ctl select, .wm-lp-ctl input:not([type=\"checkbox\"]) { height: 28px; padding: 0 6px; font-size: var(--text-sm);",
			"  border: 1px solid var(--border-color); border-radius: var(--border-radius); background: var(--control-bg);",
			"  color: var(--text-color); }",
			".wm-lp-ctl.wm-lp-check { flex-direction: row; align-items: center; gap: 6px; height: 28px; }",
			".wm-lp-ctl.wm-lp-check > label { text-transform: none; letter-spacing: 0; font-size: var(--text-sm);",
			"  color: var(--text-color); }",
			".wm-lp-spacer { flex: 1 1 auto; }",
			".wm-lp-body { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }",
			".wm-lp-stage { flex: 1 1 320px; min-width: 260px; }",
			".wm-lp-paper { display: inline-block; padding: 10px; background: repeating-conic-gradient(",
			"  var(--gray-100) 0% 25%, var(--gray-200) 0% 50%) 50% / 16px 16px;",
			"  border-radius: var(--border-radius-md); max-width: 100%; overflow: auto; }",
			".wm-lp-paper canvas { display: block; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.28);",
			"  image-rendering: pixelated; image-rendering: crisp-edges; }",
			".wm-lp-caption { margin-top: 8px; color: var(--text-muted); font-size: var(--text-xs); }",
			".wm-lp-side { flex: 0 1 300px; min-width: 240px; }",
			".wm-lp-side h6 { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .04em;",
			"  color: var(--text-muted); margin: 0 0 6px; }",
			".wm-lp-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; align-items: center; }",
			".wm-lp-grid label { margin: 0; font-size: var(--text-xs); color: var(--text-muted); white-space: nowrap; }",
			".wm-lp-grid input { width: 100%; height: 26px; padding: 0 6px; font-size: var(--text-sm);",
			"  border: 1px solid var(--border-color); border-radius: var(--border-radius);",
			"  background: var(--control-bg); color: var(--text-color); }",
			".wm-lp-msgs { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }",
			".wm-lp-msg { padding: 6px 10px; border-radius: var(--border-radius); font-size: var(--text-sm);",
			"  border-left: 3px solid; }",
			".wm-lp-msg.warn { background: var(--alert-bg-warning, #fff8e6); border-color: var(--yellow-400, #e5a000);",
			"  color: var(--text-color); }",
			".wm-lp-msg.err { background: var(--alert-bg-danger, #fff0f0); border-color: var(--red-400, #e24c4b);",
			"  color: var(--text-color); }",
			".wm-lp-tspl { margin-top: 12px; }",
			".wm-lp-tspl summary { cursor: pointer; color: var(--text-muted); font-size: var(--text-sm); }",
			".wm-lp-tspl pre { margin-top: 8px; padding: 10px 12px; max-height: 260px; overflow: auto;",
			"  background: var(--fg-color); border: 1px solid var(--border-color);",
			"  border-radius: var(--border-radius); font-size: var(--text-xs); white-space: pre; }",
			".wm-lp-empty { padding: 24px; text-align: center; color: var(--text-muted);",
			"  border: 1px dashed var(--border-color); border-radius: var(--border-radius-md); }",
		].join("\n");
		document.head.appendChild(style);
	}

	class LabelPreview {
		constructor(opts) {
			this.frm = opts.frm;
			this.$wrapper = $(opts.wrapper);
			const state = loadState();
			this.settings = state.settings;
			this.product = state.product;
			this.discount = state.discount;
			this.controls = {};
			this.serverSettings = null;
			this.settingsLoaded = false;
			// Attachment URL -> {state, img}, so a redraw does not refetch every image.
			this.images = {};
			injectStyles();
			this.make();
			this.applyServerSettings();
		}

		// True while this instance still owns the given wrapper and its DOM is intact, so
		// the form can reuse it instead of paying for a rebuild and another read of
		// App Settings on every refresh.
		isMountedOn(wrapper) {
			const mine = this.$wrapper && this.$wrapper[0];
			return (
				!!mine &&
				mine === $(wrapper)[0] &&
				this.$wrapper.children(".wm-lp-toolbar").length > 0
			);
		}

		persist() {
			saveState({
				settings: this.settings,
				product: this.product,
				discount: this.discount,
			});
		}

		make() {
			this.$wrapper.empty().addClass("wm-lp");
			$(
				'<div class="wm-lp-banner">Preview only — this draws the label in the browser ' +
					"so it can be checked before printing. Nothing here is ever sent to a printer; " +
					"the mobile app builds and sends the real job.</div>"
			).appendTo(this.$wrapper);
			this.$toolbar = $('<div class="wm-lp-toolbar"></div>').appendTo(this.$wrapper);
			const $body = $('<div class="wm-lp-body"></div>').appendTo(this.$wrapper);
			this.$stage = $('<div class="wm-lp-stage"></div>').appendTo($body);
			this.$side = $('<div class="wm-lp-side"></div>').appendTo($body);
			this.$msgs = $('<div class="wm-lp-msgs"></div>').appendTo(this.$wrapper);
			this.$tspl = $(
				'<details class="wm-lp-tspl"><summary>TSPL commands sent to the printer</summary><pre></pre></details>'
			).appendTo(this.$wrapper);

			this.$paper = $('<div class="wm-lp-paper"></div>').appendTo(this.$stage);
			this.canvas = document.createElement("canvas");
			this.$paper.append(this.canvas);
			this.$caption = $('<div class="wm-lp-caption"></div>').appendTo(this.$stage);
			this.$source = $('<div class="wm-lp-caption wm-lp-source"></div>').appendTo(this.$stage);

			this.buildToolbar();
			this.buildSampleForm();
			this.refresh();
		}

		control(label, $input) {
			const $ctl = $('<div class="wm-lp-ctl"></div>');
			$ctl.append($("<label></label>").text(label));
			$ctl.append($input);
			this.$toolbar.append($ctl);
			return $input;
		}

		select(label, key, options, onChange) {
			const $sel = $("<select></select>");
			options.forEach((opt) => {
				const value = typeof opt === "object" ? opt.value : opt;
				const text = typeof opt === "object" ? opt.label : opt;
				$sel.append($("<option></option>").attr("value", value).text(text));
			});
			$sel.val(String(this.settings[key]));
			$sel.on("change", () => {
				const raw = $sel.val();
				this.settings[key] = isNaN(Number(raw)) || raw === "" ? raw : Number(raw);
				this.markCustom(key);
				this.persist();
				if (onChange) onChange();
				this.refresh();
			});
			this.controls[key] = $sel;
			return this.control(label, $sel);
		}

		// Touching anything the server owns pins the whole set, so the preview stops
		// silently drifting back to App Settings on the next reload.
		markCustom(key) {
			if (SERVER_BACKED.indexOf(key) !== -1) this.settings.custom = true;
		}

		syncControls() {
			Object.keys(this.controls).forEach((key) => {
				this.controls[key].val(String(this.settings[key]));
			});
			if (this.$symbolInput) this.$symbolInput.val(this.settings.currencySymbol);
		}

		async applyServerSettings() {
			this.serverSettings = await fetchServerSettings();
			this.settingsLoaded = true;
			if (!this.settings.custom) {
				Object.assign(this.settings, this.serverSettings);
				this.syncControls();
				this.refresh();
			}
			this.updateSourceNote();
		}

		updateSourceNote() {
			if (!this.$source) return;
			const known = this.serverSettings && Object.keys(this.serverSettings).length;
			let text;
			if (this.settings.custom) {
				text =
					"Print options are overridden here for testing and do not match App Settings.";
			} else if (!this.settingsLoaded) {
				// refresh() runs synchronously from make(), before the fetch resolves. Saying
				// "could not be read" here would accuse the server of being broken while the
				// request is still in the air.
				text = "Reading print options from App Settings…";
			} else if (known) {
				text = "Print options are read from App Settings.";
			} else {
				text = "App Settings could not be read, so the built-in defaults are shown.";
			}
			this.$source.text(text).toggleClass("wm-lp-pinned", !!this.settings.custom);
			this.$useServer.toggle(!!this.settings.custom);
		}

		buildToolbar() {
			this.select("Printer", "dpi", [
				{ value: 203, label: "203 dpi" },
				{ value: 300, label: "300 dpi" },
			]);

			this.select("Zoom", "zoom", [
				{ value: 0, label: "Fit" },
				{ value: 1, label: "1x" },
				{ value: 2, label: "2x" },
				{ value: 3, label: "3x" },
				{ value: 4, label: "4x" },
				{ value: 6, label: "6x" },
			]);

			this.select("Barcode", "barcodeType", ["128", "EAN13"]);

			this.select("Price format", "priceFormat", [
				{ value: "#.###,##", label: "1.234,56" },
				{ value: "####,##", label: "1234,56" },
				{ value: "#,###.##", label: "1,234.56" },
				{ value: "####.##", label: "1234.56" },
			]);

			this.select("Currency", "currencyMode", ["Symbol", "Text"]);

			const $sym = $('<input type="text" size="4">').val(this.settings.currencySymbol);
			$sym.on("input", () => {
				this.settings.currencySymbol = $sym.val();
				this.markCustom("currencySymbol");
				this.persist();
				this.refresh();
			});
			this.$symbolInput = $sym;
			this.control("Symbol", $sym);

			// Changes only how wide and tall the preview measures text, never the output.
			this.select("Font metrics", "fontMetrics", [
				{ value: "tspl", label: "TSPL manual" },
				{ value: "field", label: "Field labels" },
			]);

			const $bit = $('<input type="checkbox">').prop("checked", !!this.settings.oneBit);
			const $bitCtl = $('<div class="wm-lp-ctl wm-lp-check"></div>')
				.append($bit)
				.append($("<label></label>").text("1-bit (as printed)"));
			$bit.on("change", () => {
				this.settings.oneBit = $bit.prop("checked");
				this.persist();
				this.refresh();
			});
			this.$toolbar.append($bitCtl);

			this.$toolbar.append('<div class="wm-lp-spacer"></div>');

			const $copy = $('<button class="btn btn-default btn-xs">Copy TSPL</button>');
			$copy.on("click", () => {
				frappe.utils.copy_to_clipboard(this.lastTspl || "");
			});
			const $png = $('<button class="btn btn-default btn-xs">Download PNG</button>');
			$png.on("click", () => this.downloadPng());
			const $reset = $('<button class="btn btn-default btn-xs">Reset sample</button>');
			$reset.on("click", () => {
				this.product = Object.assign({}, DEFAULT_PRODUCT);
				this.discount = Object.assign({}, DEFAULT_DISCOUNT);
				this.persist();
				this.buildSampleForm();
				this.refresh();
			});
			this.$useServer = $(
				'<button class="btn btn-default btn-xs">Use App Settings</button>'
			).hide();
			this.$useServer.on("click", () => {
				this.settings.custom = false;
				Object.assign(this.settings, DEFAULT_SETTINGS_SERVER_SLICE(), this.serverSettings || {});
				this.syncControls();
				this.persist();
				this.updateSourceNote();
				this.refresh();
			});
			this.$toolbar.append(
				$('<div class="wm-lp-ctl"></div>')
					.append($("<label></label>").text(" "))
					.append($('<div class="btn-group"></div>').append($copy, $png, $reset, this.$useServer))
			);
		}

		buildSampleForm() {
			this.$side.empty();

			const addGroup = (title, fields, target) => {
				this.$side.append($("<h6></h6>").text(title));
				const $grid = $('<div class="wm-lp-grid"></div>').appendTo(this.$side);
				fields.forEach((f) => {
					$grid.append($("<label></label>").text(f.label));
					const type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
					const $input = $("<input>").attr("type", type).val(target[f.key]);
					if (f.type === "number") $input.attr("step", "0.01");
					$input.on("input change", () => {
						const raw = $input.val();
						target[f.key] = f.type === "number" ? Number(raw) || 0 : raw;
						this.persist();
						this.refresh();
					});
					$grid.append($input);
				});
			};

			addGroup("Sample product", PRODUCT_FIELDS, this.product);
			if (this.frm && this.frm.doc.is_label_discount) {
				this.$side.append('<div style="height:12px"></div>');
				addGroup("Sample discount", DISCOUNT_FIELDS, this.discount);
			}
		}

		buildDoc() {
			const doc = this.frm.doc;
			return {
				label_width: Number(doc.label_width) || 0,
				label_height: Number(doc.label_height) || 0,
				label_gap: Number(doc.label_gap) || 0,
				item_table: (doc.item_table || []).map((row) => ({
					item_select: row.item_select,
					item_text: row.item_text,
					item_image: row.item_image,
					limit: row.limit,
					line_limit: row.line_limit,
					wrap_offset: row.wrap_offset,
					item_x: row.item_x,
					item_y: row.item_y,
					font_size: row.font_size,
					font_name: row.font_name,
				})),
			};
		}

		refresh() {
			const doc = this.buildDoc();
			if (!doc.label_width || !doc.label_height) {
				this.$paper.hide();
				this.$caption.hide();
				this.$source.hide();
				this.$stage.find(".wm-lp-empty").remove();
				this.$stage.prepend(
					'<div class="wm-lp-empty">Set a width and a height to see the label.</div>'
				);
				this.$msgs.empty();
				this.$tspl.hide();
				return;
			}
			this.$stage.find(".wm-lp-empty").remove();
			this.$paper.show();
			this.$caption.show();
			this.$source.show();
			this.$tspl.show();
			// Every path that changes a setting lands here, so this is the one place the
			// "where did these values come from" line has to be kept honest.
			this.updateSourceNote();

			const discount = this.frm.doc.is_label_discount ? this.discount : null;

			const result = warehouse_management.tspl.build(doc, this.product, discount, {
				barcodeType: this.settings.barcodeType,
				printerEncoding: this.settings.printerEncoding,
				priceFormat: this.settings.priceFormat,
				currencyMode: this.settings.currencyMode,
				currencySymbol: this.settings.currencySymbol,
				currencyName: this.settings.currencyName,
				fontMetrics: this.settings.fontMetrics,
				imageSizes: this.decodedImageSizes(),
			});

			this.lastTspl = result.tspl;
			this.$tspl.find("pre").text(result.tspl);

			const drawWarnings = this.draw(doc, result.ops);
			this.renderMessages(result.warnings.concat(drawWarnings));
		}

		draw(doc, ops) {
			const dotsPerMm = warehouse_management.tspl.DOTS_PER_MM[this.settings.dpi] || 8;
			const width = Math.max(1, Math.round(doc.label_width * dotsPerMm));
			const height = Math.max(1, Math.round(doc.label_height * dotsPerMm));
			const warnings = [];

			this.canvas.width = width;
			this.canvas.height = height;
			const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, width, height);
			ctx.fillStyle = "#000000";

			const boxes = [];
			ops.forEach((op) => {
				let box;
				if (op.type === "text") box = this.drawText(ctx, op);
				else if (op.type === "barcode") box = this.drawBarcode(ctx, op, warnings);
				else if (op.type === "image") box = this.drawImage(ctx, op, warnings);
				if (box) boxes.push(Object.assign({ row: op.row }, box));
			});

			if (this.settings.oneBit) this.threshold(ctx, width, height);

			// Markers are drawn after thresholding so they keep their colour instead of
			// being reduced to black along with the printable content.
			ctx.save();
			ctx.strokeStyle = "#e24c4b";
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 3]);
			boxes.forEach((box) => {
				if (!box.marker) return;
				ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(6, box.w), Math.max(4, box.h));
			});
			boxes.forEach((box) => {
				const overflows =
					box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height;
				if (!overflows) return;
				ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(1, box.w - 1), Math.max(1, box.h - 1));
				warnings.push(
					"Row " +
						box.row +
						" runs off the label (" +
						Math.round(box.x) +
						"," +
						Math.round(box.y) +
						" to " +
						Math.round(box.x + box.w) +
						"," +
						Math.round(box.y + box.h) +
						" dots, label is " +
						width +
						"x" +
						height +
						") and is clipped when printed."
				);
			});
			ctx.restore();

			this.applyZoom(width, height);
			this.$caption.text(
				doc.label_width +
					" × " +
					doc.label_height +
					" mm  ·  " +
					width +
					" × " +
					height +
					" dots @ " +
					this.settings.dpi +
					" dpi  ·  gap " +
					doc.label_gap +
					" mm"
			);
			return warnings;
		}

		drawText(ctx, op) {
			if (op.font.kind === "builtin") {
				const cell = op.font.cell;
				const cw = cell[0];
				const ch = cell[1];
				// A bitmap dot font fills its cell: an 8x12 glyph really is about 9 dots of
				// ink tall, with only a dot or two of leading. A browser font at N pixels
				// puts roughly N pixels between ascender and descender, so the cell height
				// is the font size. Scaling it down to 0.86 of that - which this used to do
				// - drew every label a sixth smaller than the head prints it, which on a
				// thermal label is the difference between legible and not.
				const size = Math.max(4, ch);
				ctx.font = size + "px " + (op.font.ocr ? OCR_STACK : MONO_STACK);
				ctx.textBaseline = "top";
				const chars = Array.from(op.text);
				chars.forEach((c, i) => {
					if (c === " ") return;
					const w = ctx.measureText(c).width || cw;
					// Built-in printer glyphs are drawn to fill their cell, so squeeze the
					// browser glyph into the same box rather than letting it drift.
					const scaleX = Math.min(1.6, (cw * 0.92) / w);
					ctx.save();
					ctx.translate(op.x + i * cw, op.y + (ch - size) / 2);
					ctx.scale(scaleX, 1);
					ctx.fillText(c, 0, 0);
					ctx.restore();
				});
				return { x: op.x, y: op.y, w: chars.length * cw, h: ch };
			}

			// A scalable font (id 0, or a downloaded TTF named in Font Name) is drawn
			// proportionally at the dot size the command asks for.
			const size = Math.max(1, op.font.size);
			// Font 0 is condensed; a downloaded TTF is not, so they get different stand-ins.
			const base = op.font.kind === "ttf" ? PROPORTIONAL_STACK : CONDENSED_STACK;
			let family = base;
			if (op.font.kind === "ttf") {
				const named = cssFamilyName(op.font.name);
				if (named) family = '"' + named + '", ' + base;
			}
			ctx.font = size + "px " + family;
			ctx.textBaseline = "top";
			ctx.fillText(op.text, op.x, op.y);
			const w = ctx.measureText(op.text).width;

			// One dot of text is invisible, so mark where it sits rather than leaving a
			// blank patch the reader has to work out for themselves.
			if (size < 4) {
				return { x: op.x, y: op.y, w: Math.max(w, 8), h: Math.max(size, 4), marker: true };
			}
			return { x: op.x, y: op.y, w: w, h: size * 1.2 };
		}

		// PUTBMP prints a BMP dot for dot, so the file's pixel size is its size on the
		// label and it is drawn with no scaling at all. The 1-bit pass afterwards flattens
		// it the way the head would, which is how a greyscale logo shows up here as the
		// blotchy thing it will actually print as.
		//
		// Decoding is asynchronous, so the first pass leaves a placeholder and the load
		// handler asks for another render once the file is in.
		drawImage(ctx, op, warnings) {
			const pending = { x: op.x, y: op.y, w: 64, h: 64, marker: true };
			if (!op.src) return pending;

			const entry = this.images[op.src];
			if (!entry) {
				this.loadImage(op.src);
				return pending;
			}
			if (entry.state === "loading") return pending;
			if (entry.state === "error") {
				warnings.push(
					"Row " +
						op.row +
						": " +
						(op.name || "the image") +
						" could not be loaded, so the preview cannot show it. The file may have " +
						"been removed, or the browser may not decode this BMP variant."
				);
				return pending;
			}

			ctx.drawImage(entry.img, op.x, op.y);
			return { x: op.x, y: op.y, w: entry.img.naturalWidth, h: entry.img.naturalHeight };
		}

		// The BITMAP command declares its payload's size, which is only known once the file
		// has been decoded. Each row is padded out to whole bytes, the same packing the
		// mobile app does when it converts the .bmp during sync.
		decodedImageSizes() {
			const sizes = {};
			Object.keys(this.images).forEach((src) => {
				const entry = this.images[src];
				if (entry.state !== "ok") return;
				const widthBytes = Math.ceil(entry.img.naturalWidth / 8);
				sizes[src] = {
					widthBytes: widthBytes,
					heightDots: entry.img.naturalHeight,
					byteCount: widthBytes * entry.img.naturalHeight,
				};
			});
			return sizes;
		}

		loadImage(src) {
			const entry = { state: "loading", img: new Image() };
			this.images[src] = entry;
			// Settling to ok or error before re-rendering is what keeps this from looping:
			// the next pass finds a cached entry instead of starting the load again.
			entry.img.onload = () => {
				entry.state = "ok";
				this.refresh();
			};
			entry.img.onerror = () => {
				entry.state = "error";
				this.refresh();
			};
			entry.img.src = src;
		}

		drawBarcode(ctx, op, warnings) {
			const encoded = warehouse_management.barcode.encode(op.symbology, op.content);
			if (encoded.error) {
				warnings.push("Row " + op.row + ": " + encoded.error);
				// Handed back as a marker rather than stroked here: drawing it now would put
				// it through the 1-bit threshold, which turns the red to solid black and
				// makes a barcode that cannot be encoded look like something the printer
				// will happily draw.
				return {
					x: op.x,
					y: op.y,
					w: Math.max(40, op.content.length * 8),
					h: op.height,
					marker: true,
				};
			}

			const module = op.narrow;
			let x = op.x;
			ctx.fillStyle = "#000000";
			encoded.modules.forEach((m) => {
				const w = m.width * module;
				if (m.bar) ctx.fillRect(x, op.y, w, op.height);
				x += w;
			});
			const totalWidth = encoded.width * module;

			let bottom = op.height;
			if (op.hri) {
				const size = Math.round(warehouse_management.tspl.HRI_HEIGHT * 0.8);
				ctx.font = size + 'px "DejaVu Sans Mono", Consolas, monospace';
				ctx.textBaseline = "top";
				ctx.textAlign = "center";
				ctx.fillText(encoded.hri, op.x + totalWidth / 2, op.y + op.height + 2);
				ctx.textAlign = "left";
				bottom += warehouse_management.tspl.HRI_HEIGHT;
			}
			return { x: op.x, y: op.y, w: totalWidth, h: bottom };
		}

		// The print head is a one-bit device, so collapse the browser's antialiasing the
		// way the printer does. A font that only survives as grey pixels will not print.
		threshold(ctx, width, height) {
			const img = ctx.getImageData(0, 0, width, height);
			const d = img.data;
			for (let i = 0; i < d.length; i += 4) {
				const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
				const v = lum < 160 ? 0 : 255;
				d[i] = d[i + 1] = d[i + 2] = v;
				d[i + 3] = 255;
			}
			ctx.putImageData(img, 0, 0);
		}

		applyZoom(width, height) {
			let zoom = Number(this.settings.zoom) || 0;
			if (!zoom) {
				const available = Math.max(200, this.$stage.width() - 24);
				zoom = Math.max(1, Math.min(6, Math.floor(available / width) || 1));
			}
			this.canvas.style.width = width * zoom + "px";
			this.canvas.style.height = height * zoom + "px";
		}

		renderMessages(messages) {
			this.$msgs.empty();
			messages.forEach((m) => {
				const kind = /runs off the label|cannot|needs|wrong/.test(m) ? "err" : "warn";
				this.$msgs.append($('<div class="wm-lp-msg"></div>').addClass(kind).text(m));
			});
		}

		downloadPng() {
			const name = (this.frm.doc.label_name || "label").replace(/[^\w.-]+/g, "_");
			const link = document.createElement("a");
			link.download = name + ".png";
			link.href = this.canvas.toDataURL("image/png");
			link.click();
		}
	}

	warehouse_management.LabelPreview = LabelPreview;

	warehouse_management.show_label_preview_dialog = function (frm) {
		const dialog = new frappe.ui.Dialog({
			title: __("Label Preview"),
			size: "extra-large",
			fields: [{ fieldtype: "HTML", fieldname: "preview" }],
		});
		dialog.show();
		// The panel measures its container to pick a fit zoom, so build it once the
		// dialog has been laid out.
		setTimeout(() => {
			new LabelPreview({ frm: frm, wrapper: dialog.fields_dict.preview.$wrapper });
			// Filling the body after it opened can leave it scrolled a little way down,
			// which clips the top of the toolbar and its labels. Put it back at the top.
			dialog.$wrapper.find(".modal-body").scrollTop(0);
		}, 0);
	};
})();
