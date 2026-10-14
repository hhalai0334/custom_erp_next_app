// Copyright (c) 2026, h.halai0334@gmail.com and contributors
// For license information, please see license.txt
//
// A JavaScript port of ErpNextMobile/Services/TscCommandBuilder.ConvertToTscEzString.
// Given a Discount Labels document and a sample product it produces the same TSPL-EZ
// command stream the mobile app sends to the TSC printer, plus the draw operations the
// preview canvas paints, so a label can be inspected without a printer.
//
// Keep this file in step with TscCommandBuilder.cs. If the builder changes and this does
// not, the preview stops telling the truth, which is worse than having no preview at all.

frappe.provide("warehouse_management.tspl");

warehouse_management.tspl = (function () {
	// A 203 dpi head puts 8 dots in a millimetre; a 300 dpi head puts 11.81.
	const DOTS_PER_MM = { 203: 8, 300: 300 / 25.4 };

	// The printer's own built-in fonts, per the TSPL/TSPL2 manual's TEXT command. These
	// are the metrics the head actually produces, so the preview uses them by default.
	//
	// They do NOT match the wording of the Font Size select on Discount Label Items,
	// which is this same table shifted by one (it calls font 3 "12x24" where the printer
	// prints 16x24, and offers font 0 as "Very small (8x12)" where the printer treats 0
	// as a scalable font). FIELD_LABEL_FONTS below keeps the select's version so the two
	// can be compared against a real printed label.
	//
	// Ids 9-30 appear in the select as "Custom Font": they are whatever the operator
	// downloaded into the printer, so the preview cannot know their metrics and says so
	// rather than guessing silently.
	const TSPL_FONTS = {
		0: { scalable: true, label: "Triumvirate Bold Condensed (scalable)" },
		1: { cell: [8, 12] },
		2: { cell: [12, 20] },
		3: { cell: [16, 24] },
		4: { cell: [24, 32] },
		5: { cell: [32, 48] },
		6: { cell: [14, 19], ocr: "B" },
		7: { cell: [21, 27], ocr: "B" },
		8: { cell: [14, 25], ocr: "A" },
	};

	// What the Font Size select on Discount Label Items claims each id is.
	const FIELD_LABEL_FONTS = {
		0: { cell: [8, 12] },
		1: { cell: [8, 16] },
		2: { cell: [12, 20] },
		3: { cell: [12, 24] },
		4: { cell: [16, 32] },
		5: { cell: [24, 32] },
		6: { cell: [32, 48] },
		7: { cell: [14, 19], ocr: "A" },
		8: { cell: [14, 25], ocr: "B" },
	};

	const FONT_TABLES = { tspl: TSPL_FONTS, field: FIELD_LABEL_FONTS };

	// Height in dots of the human readable text TSPL prints under a barcode.
	const HRI_HEIGHT = 24;

	/* ------------------------------------------------------------------ *
	 * Number formatting - port of Core/PriceFormatter.FormatNumber
	 * ------------------------------------------------------------------ */

	function formatNumber(value, priceFormat) {
		const v = Number(value);
		const n = isFinite(v) ? v : 0;
		switch (priceFormat) {
			case "#.###,##":
			case "X.xxx,xx":
				return fixed(n, ".", ",", true);
			case "####,##":
			case "Xxxx,xx":
				return fixed(n, "", ",", false);
			case "#,###.##":
			case "X,xxxx.xx":
				return fixed(n, ",", ".", true);
			case "####.##":
			case "Xxxx.xx":
			default:
				return fixed(n, "", ".", false);
		}
	}

	function fixed(n, groupSep, decSep, grouped) {
		const neg = n < 0;
		const parts = Math.abs(n).toFixed(2).split(".");
		let whole = parts[0];
		if (grouped && groupSep) {
			whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
		}
		return (neg ? "-" : "") + whole + decSep + parts[1];
	}

	/* ------------------------------------------------------------------ *
	 * Placeholder arithmetic - port of EvaluatePlaceholderMath and friends.
	 * Supports parentheses and precedence, e.g. (1-{Price}/{OldPrice})*100.
	 * Only spans containing at least one operator are replaced, so a bare
	 * {Price} falls through to the plain placeholder substitution below.
	 * ------------------------------------------------------------------ */

	function evaluatePlaceholderMath(text, numericValues, priceFormat) {
		if (!text) return text || "";

		let out = "";
		let i = 0;
		while (i < text.length) {
			// Never start a match on whitespace, or the space in front of an
			// expression is swallowed into the replacement.
			if (/\s/.test(text[i])) {
				out += text[i];
				i++;
				continue;
			}

			const st = { pos: i, operators: 0, aborted: false };
			const res = parseExpression(text, numericValues, st);
			if (res.ok && st.operators > 0) {
				out += formatNumber(res.value, priceFormat);
				i = st.pos;
			} else if (st.aborted && st.pos > i) {
				// Division by zero: copy the span verbatim so the scan does not
				// re-enter it and evaluate a fragment of it in isolation.
				out += text.slice(i, st.pos);
				i = st.pos;
			} else {
				out += text[i];
				i++;
			}
		}
		return out;
	}

	function skipWhitespace(text, st) {
		while (st.pos < text.length && /\s/.test(text[st.pos])) st.pos++;
	}

	function parseExpression(text, values, st) {
		const first = parseTerm(text, values, st);
		if (!first.ok) return first;
		let result = first.value;

		for (;;) {
			const save = st.pos;
			const savedOps = st.operators;
			skipWhitespace(text, st);
			if (st.pos >= text.length || (text[st.pos] !== "+" && text[st.pos] !== "-")) {
				st.pos = save;
				return { ok: true, value: result };
			}
			const op = text[st.pos];
			st.pos++;
			const right = parseTerm(text, values, st);
			if (!right.ok) {
				if (st.aborted) return { ok: false, value: 0 };
				st.pos = save;
				st.operators = savedOps;
				return { ok: true, value: result };
			}
			st.operators++;
			result = op === "+" ? result + right.value : result - right.value;
		}
	}

	function parseTerm(text, values, st) {
		const first = parseFactor(text, values, st);
		if (!first.ok) return first;
		let result = first.value;

		for (;;) {
			const save = st.pos;
			const savedOps = st.operators;
			skipWhitespace(text, st);
			const c = text[st.pos];
			if (st.pos >= text.length || (c !== "*" && c !== "x" && c !== "/")) {
				st.pos = save;
				return { ok: true, value: result };
			}
			st.pos++;
			const right = parseFactor(text, values, st);
			if (!right.ok) {
				if (st.aborted) return { ok: false, value: 0 };
				st.pos = save;
				st.operators = savedOps;
				return { ok: true, value: result };
			}
			// Division by zero aborts the whole expression rather than backtracking, so
			// the caller skips the entire span instead of evaluating the part before the
			// division on its own.
			if (c === "/" && right.value === 0) {
				st.aborted = true;
				return { ok: false, value: 0 };
			}
			st.operators++;
			result = c === "/" ? result / right.value : result * right.value;
		}
	}

	function parseFactor(text, values, st) {
		skipWhitespace(text, st);
		if (st.pos >= text.length) return { ok: false, value: 0 };

		const save = st.pos;
		const savedOps = st.operators;

		if (text[st.pos] === "-") {
			st.pos++;
			const inner = parseFactor(text, values, st);
			if (!inner.ok) {
				if (st.aborted) return { ok: false, value: 0 };
				st.pos = save;
				st.operators = savedOps;
				return { ok: false, value: 0 };
			}
			return { ok: true, value: -inner.value };
		}

		if (text[st.pos] === "(") {
			st.pos++;
			const inner = parseExpression(text, values, st);
			if (!inner.ok) {
				if (st.aborted) return { ok: false, value: 0 };
				st.pos = save;
				st.operators = savedOps;
				return { ok: false, value: 0 };
			}
			skipWhitespace(text, st);
			if (st.pos >= text.length || text[st.pos] !== ")") {
				st.pos = save;
				st.operators = savedOps;
				return { ok: false, value: 0 };
			}
			st.pos++;
			return { ok: true, value: inner.value };
		}

		if (text[st.pos] === "{") {
			const close = text.indexOf("}", st.pos);
			if (close < 0) return { ok: false, value: 0 };
			const name = text.slice(st.pos + 1, close);
			if (!name.length || !/^[A-Za-z0-9_]+$/.test(name)) return { ok: false, value: 0 };
			if (!Object.prototype.hasOwnProperty.call(values, name)) return { ok: false, value: 0 };
			st.pos = close + 1;
			return { ok: true, value: values[name] };
		}

		while (st.pos < text.length && (/[0-9]/.test(text[st.pos]) || text[st.pos] === ".")) {
			st.pos++;
		}
		if (st.pos === save) return { ok: false, value: 0 };

		// float.TryParse with NumberStyles.Number and InvariantCulture takes at most one
		// decimal point - the group separator there is a comma, which the scan above never
		// consumes - so it rejects a run like 1.2.3 outright. parseFloat would instead
		// truncate it to 1.2 and let the expression evaluate, which is how "1.2.3*2"
		// previewed as 2.40 while the printer prints it literally.
		const slice = text.slice(save, st.pos);
		const wellFormed = /\d/.test(slice) && (slice.match(/\./g) || []).length <= 1;
		const num = wellFormed ? parseFloat(slice) : NaN;
		if (!isFinite(num)) {
			st.pos = save;
			return { ok: false, value: 0 };
		}
		return { ok: true, value: num };
	}

	/* ------------------------------------------------------------------ *
	 * Text handling - ports of SanitizeForTspl and SplitTextByCharLimit
	 * ------------------------------------------------------------------ */

	// TSPL has no escape that preserves length, and Limit/LineLimit count printed
	// characters, so the builder swaps a double quote for an apostrophe rather than
	// letting it terminate the command parameter early.
	function sanitizeForTspl(text) {
		return (text || "").replace(/"/g, "'");
	}

	function splitTextByCharLimit(text, charLimit) {
		const words = text.split(" ");
		const lines = [];
		let current = "";

		for (const word of words) {
			if (current.length + word.length + 1 <= charLimit) {
				if (current.length > 0) current += " ";
				current += word;
			} else {
				if (current.length > 0) {
					lines.push(current);
					current = "";
				}
				if (word.length > charLimit) {
					for (let i = 0; i < word.length; i += charLimit) {
						lines.push(word.substr(i, Math.min(charLimit, word.length - i)));
					}
				} else {
					current += word;
				}
			}
		}
		if (current.length > 0) lines.push(current);
		return lines;
	}

	function replaceAll(text, token, value) {
		return (text || "").split(token).join(value == null ? "" : String(value));
	}

	function flatten(text) {
		return (text || "").replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ");
	}

	/* ------------------------------------------------------------------ *
	 * The builder itself
	 * ------------------------------------------------------------------ */

	// doc      - a Discount Labels document (label_width/height/gap + item_table)
	// product  - sample values keyed like ErpNextMobile Core.DbModels.Product
	// discount - sample discount values, or null when this is not a discount label
	// opts     - { barcodeType, printerEncoding, priceFormat, currencyMode,
	//              currencySymbol, currencyName, fontMetrics }
	//
	// fontMetrics picks which font table the preview measures with: "tspl" (what the
	// printer does) or "field" (what the Font Size select says). It changes nothing in
	// the emitted commands - only how wide and tall the preview draws the text.
	//
	// Returns { tspl, ops, warnings }; ops are the draw operations for the canvas.
	function build(doc, product, discount, opts) {
		const o = Object.assign(
			{
				barcodeType: "128",
				printerEncoding: "UTF8",
				priceFormat: "#.###,##",
				currencyMode: "Symbol",
				currencySymbol: "€",
				currencyName: "EUR",
				fontMetrics: "tspl",
				imageSizes: null,
			},
			opts || {}
		);
		const fontTable = FONT_TABLES[o.fontMetrics] || TSPL_FONTS;

		const lines = [];
		const ops = [];
		const warnings = [];

		lines.push("SIZE " + (doc.label_width || 0) + " mm, " + (doc.label_height || 0) + " mm");
		lines.push("GAP " + (doc.label_gap || 0) + " mm, 0");
		lines.push("DIRECTION 0");
		lines.push("CLS");
		if (o.printerEncoding !== "UTF8") lines.push("CODEPAGE " + o.printerEncoding);

		const numericValues = {
			Price: Number(product.Price) || 0,
			WholesalePrice: Number(product.WholesalePrice) || 0,
			OldPrice: Number(product.OldPrice) || 0,
		};
		if (discount) {
			numericValues.DiscountPrice = Number(discount.Price) || 0;
			numericValues.LowestPrice = Number(discount.LowestPrice) || 0;
		}

		// Only a product that actually has a static price contributes one, so {StaticPrice}*2
		// on a product without one is left unevaluated rather than quietly reading as zero.
		const staticPrice =
			product.StaticPrice === null ||
			product.StaticPrice === undefined ||
			product.StaticPrice === "" ||
			!(Number(product.StaticPrice) > 0)
				? null
				: Number(product.StaticPrice);
		if (staticPrice !== null) {
			numericValues.StaticPrice = staticPrice;
		}

		const currencyText = o.currencyMode === "Text" ? o.currencyName : o.currencySymbol;
		const rows = doc.item_table || [];
		const imageRows = [];

		rows.forEach(function (row, index) {
			let text = evaluatePlaceholderMath(row.item_text || "", numericValues, o.priceFormat);

			text = replaceAll(text, "{Name}", product.Name);
			text = replaceAll(text, "{Name2}", product.Name2);
			text = replaceAll(text, "{Model}", product.Model);
			text = replaceAll(text, "{A1}", product.A1);
			text = replaceAll(text, "{A2}", product.A2);
			text = replaceAll(text, "{A3}", product.A3);
			text = replaceAll(text, "{A4}", product.A4);
			text = replaceAll(text, "{Size}", product.A2);
			text = replaceAll(text, "{Barcode}", product.Barcode);
			text = replaceAll(text, "{MPN}", product.Mpn);
			text = replaceAll(text, "{ExternalId}", product.ExternalId);
			text = replaceAll(text, "{Currency}", currencyText);
			text = replaceAll(text, "{Price}", formatNumber(product.Price, o.priceFormat));
			text = replaceAll(
				text,
				"{WholesalePrice}",
				formatNumber(product.WholesalePrice, o.priceFormat)
			);
			text = replaceAll(text, "{OldPrice}", formatNumber(product.OldPrice, o.priceFormat));
			text = replaceAll(text, "{Id}", product.Id);
			text = replaceAll(text, "{Description}", flatten(product.Description));
			text = replaceAll(text, "{Description2}", flatten(product.Description2));
			text = replaceAll(text, "{Country}", product.Country);
			text = replaceAll(text, "Đ", "D");

			// With no static price to print, the placeholder is blanked and the rest of the
			// row prints as written - the same as the builder does.
			text = replaceAll(
				text,
				"{StaticPrice}",
				staticPrice === null ? "" : formatNumber(staticPrice, o.priceFormat)
			);

			text = replaceDate(text, "Date", new Date(), "g");
			text = replaceDate(text, "StaticPriceDate", parseLocalDate(product.StaticPriceDate), "d");

			if (discount) {
				text = replaceAll(text, "{DiscountPrice}", formatNumber(discount.Price, o.priceFormat));
				text = replaceAll(
					text,
					"{LowestPrice}",
					formatNumber(discount.LowestPrice, o.priceFormat)
				);
				text = replaceAll(text, "{DiscountNo}", discount.DiscountNo || "");
				text = replaceDate(text, "DiscountEndDate", parseLocalDate(discount.EndDate), "d");
				text = replaceDate(text, "DiscountStartDate", parseLocalDate(discount.StartDate), "d");
			}

			// Split the leftovers by cause. Telling someone their typo needs the Discount
			// box ticked sends them somewhere that cannot help.
			// Also catches the {Name:format} form, so a mistyped date placeholder is
			// reported rather than printed verbatim.
			const leftover = text.match(/\{[A-Za-z0-9_]+(?::[^{}]*)?\}/g);
			if (leftover) {
				const names = unique(leftover);
				const needsDiscount = names.filter(isDiscountPlaceholder);
				const unknown = names.filter((n) => !isDiscountPlaceholder(n));
				if (needsDiscount.length && !discount) {
					warnings.push(
						"Row " +
							(index + 1) +
							": " +
							needsDiscount.join(", ") +
							" only resolves on a discount label - tick Discount, or it prints literally."
					);
				}
				if (unknown.length) {
					warnings.push(
						"Row " +
							(index + 1) +
							": " +
							unknown.join(", ") +
							" is not a known placeholder and prints literally."
					);
				}
			}

			const kind = (row.item_select || "").toLowerCase();
			const x = Number(row.item_x) || 0;
			const y = Number(row.item_y) || 0;

			if (kind === "text") {
				let font;
				let fontSizeParam;
				let metrics;

				if (row.font_name && row.font_name.trim()) {
					// TTF font: the size params are dot height/width parsed from Font Size.
					font = row.font_name.trim();
					const size = parseIntOr(firstSegment(row.font_size), 24);
					fontSizeParam = size + "," + size;
					// For a downloaded TrueType font the two size parameters are a POINT size,
					// not dots - unlike the built-in scalable font 0, where they are dots.
					// The app's own printer font test page says so in as many words (it
					// prints "9pt Test text" at 9,9) and its line pitches bear it out: 6pt to
					// 7pt is 22 dots, 12pt to 13pt is 39, converging on the 2.82 dots a point
					// is worth at 203 dpi plus leading. The preview converts with the
					// selected dpi; drawing the number as dots made every row 2.8x too small.
					metrics = { kind: "ttf", name: font, size: size, unit: "pt" };
				} else {
					// Built-in font: the first segment is the font id, and the builder always
					// sends 1,1 for the two size parameters.
					font = firstSegment(row.font_size);
					fontSizeParam = "1,1";
					const id = parseIntOr(font, -1);
					const spec = fontTable[id];
					if (!spec) {
						warnings.push(
							"Row " +
								(index + 1) +
								': font "' +
								font +
								'" is a downloaded printer font, so its size is unknown here - ' +
								"the preview draws it as 16x24."
						);
						metrics = { kind: "builtin", id: font, cell: [16, 24], unknown: true };
					} else if (spec.scalable) {
						// For a scalable font the two size parameters are the glyph width and
						// height in dots, not multipliers - so the 1,1 the builder sends prints
						// this row about one dot tall, which is nothing.
						warnings.push(
							"Row " +
								(index + 1) +
								': font "' +
								font +
								'" is ' +
								spec.label +
								", where the size parameters are dots, not multipliers. The label " +
								"sends 1,1, so this row prints about one dot tall. Give the row a " +
								"Font Name and a size, or pick a fixed-pitch font (1-8)."
						);
						// Font 0's parameters are dots, so 1,1 really is one dot.
						metrics = { kind: "scalable", id: font, size: 1, unit: "dot" };
					} else {
						metrics = { kind: "builtin", id: font, cell: spec.cell, ocr: spec.ocr };
					}
				}

				let line = sanitizeForTspl(text);
				const limit = Number(row.limit) || 0;
				if (limit > 0 && line.length > limit) line = line.slice(0, limit).trim();

				const lineLimit = Number(row.line_limit) || 0;
				if (lineLimit > 0 && line.length > lineLimit) {
					const wrapped = splitTextByCharLimit(line, lineLimit);
					let wrapOffset = Number(row.wrap_offset) || 0;
					if (wrapOffset === 0) wrapOffset = 20;
					let ly = y;
					for (const seg of wrapped) {
						lines.push(
							"TEXT " + x + "," + ly + ',"' + font + '",0,' + fontSizeParam + ',"' + seg + '"'
						);
						ops.push({ type: "text", row: index + 1, x: x, y: ly, text: seg, font: metrics });
						ly += wrapOffset;
					}
				} else {
					lines.push(
						"TEXT " + x + "," + y + ',"' + font + '",0,' + fontSizeParam + ',"' + line + '"'
					);
					ops.push({ type: "text", row: index + 1, x: x, y: y, text: line, font: metrics });
				}
			} else if (kind === "barcode") {
				const size = parseIntOr(firstSegment(row.font_size), 100);
				const content = sanitizeForTspl(text);
				lines.push(
					"BARCODE " + x + "," + y + ',"' + o.barcodeType + '",' + size + ',1,0,2,2,"' + content + '"'
				);
				ops.push({
					type: "barcode",
					row: index + 1,
					x: x,
					y: y,
					height: size,
					content: content,
					symbology: o.barcodeType,
					narrow: 2,
					wide: 2,
					hri: true,
				});
			} else if (kind === "image") {
				// BITMAP carries the picture itself: an ASCII header, then one bit per dot,
				// then a newline. The mobile app converts the uploaded .bmp once during sync
				// and splices the payload in at print time, so nothing has to be pre-loaded
				// into the printer's memory and a swapped printer needs no setup.
				//
				// BITMAP has no scale parameter, so Image Width and Image Height are not a
				// print-time instruction - the picture is resampled to that many dots before
				// it is packed, by the app during sync and by the canvas here. The natural
				// size is only known once the file has been decoded, so a row that leaves
				// both at 0 shows its dimensions as pending until then.
				const natural = (o.imageSizes || {})[row.item_image];
				const target = resolveImageSize(row.image_width, row.image_height, natural);
				if (!row.item_image) {
					warnings.push("Row " + (index + 1) + ": no image is attached, so nothing prints.");
				}

				const widthBytes = target ? Math.ceil(target.widthDots / 8) : 0;
				lines.push(
					"BITMAP " +
						x +
						"," +
						y +
						"," +
						(target ? widthBytes : "?") +
						"," +
						(target ? target.heightDots : "?") +
						",0," +
						(target
							? "<" + widthBytes * target.heightDots + " bytes of bitmap>"
							: "<image not loaded>")
				);
				ops.push({
					type: "image",
					row: index + 1,
					x: x,
					y: y,
					src: row.item_image || "",
					name: imageName(row),
					width: target ? target.widthDots : 0,
					height: target ? target.heightDots : 0,
					resized: !!(target && natural &&
						(target.widthDots !== natural.widthDots || target.heightDots !== natural.heightDots)),
				});
				imageRows.push(index + 1);
			} else if (kind) {
				warnings.push(
					"Row " + (index + 1) + ': unknown type "' + row.item_select + '" - nothing is printed.'
				);
			}
		});

		// An image only reaches the printer once a sync has downloaded and converted it, so
		// a label edited since the last sync prints its text and quietly drops the picture.
		if (imageRows.length) {
			warnings.push(
				"Image row" +
					(imageRows.length > 1 ? "s " : " ") +
					imageRows.join(", ") +
					": the mobile app prints these from its own copy of the file, so run a sync " +
					"after changing an image or the old one keeps printing."
			);
		}

		lines.push("PRINT 1");
		return { tspl: lines.join("\r\n") + "\r\n", ops: ops, warnings: warnings };
	}

	// The placeholders the builder only substitutes when a discount is in play.
	const DISCOUNT_PLACEHOLDERS = [
		"{DiscountPrice}",
		"{LowestPrice}",
		"{DiscountStartDate}",
		"{DiscountEndDate}",
		"{DiscountNo}",
	];

	function isDiscountPlaceholder(token) {
		// {DiscountEndDate:dd.MM.yyyy} is the same placeholder as {DiscountEndDate}.
		const name = "{" + token.replace(/^\{|\}$/g, "").split(":")[0] + "}";
		return DISCOUNT_PLACEHOLDERS.indexOf(name) !== -1;
	}

	function unique(arr) {
		return arr.filter(function (v, i) {
			return arr.indexOf(v) === i;
		});
	}

	// What the picture will actually be resampled to, in dots.
	//
	// 0 means "take it from the file". Setting one axis and leaving the other at 0 keeps
	// the aspect ratio, which is what someone fitting a logo to a column width means; it
	// also stops a half-filled row from printing a stretched picture. Returns null while
	// the natural size is still unknown and the row has not pinned both axes itself.
	function resolveImageSize(requestedWidth, requestedHeight, natural) {
		const rw = Math.max(0, Math.round(Number(requestedWidth) || 0));
		const rh = Math.max(0, Math.round(Number(requestedHeight) || 0));

		const haveNatural = !!(natural && natural.widthDots > 0 && natural.heightDots > 0);
		if (!haveNatural) {
			return rw > 0 && rh > 0 ? { widthDots: rw, heightDots: rh } : null;
		}
		if (rw <= 0 && rh <= 0) {
			return { widthDots: natural.widthDots, heightDots: natural.heightDots };
		}
		if (rw > 0 && rh <= 0) {
			return {
				widthDots: rw,
				heightDots: Math.max(1, Math.round((natural.heightDots * rw) / natural.widthDots)),
			};
		}
		if (rw <= 0 && rh > 0) {
			return {
				widthDots: Math.max(1, Math.round((natural.widthDots * rh) / natural.heightDots)),
				heightDots: rh,
			};
		}
		return { widthDots: rw, heightDots: rh };
	}

	// The name PUTBMP refers to the file by: Item Text when the row sets one, otherwise the
	// uploaded file's own name with the folders stripped off.
	function imageName(row) {
		const override = (row.item_text || "").trim();
		if (override) return sanitizeForTspl(override);

		const path = String(row.item_image || "").split(/[?#]/)[0];
		const base = path.split("/").pop() || "";
		return sanitizeForTspl(safeDecode(base));
	}

	function safeDecode(value) {
		try {
			return decodeURIComponent(value);
		} catch (e) {
			// A stray percent in the file name is not worth failing the whole preview over.
			return value;
		}
	}

	function firstSegment(value) {
		return String(value == null ? "" : value).split("-")[0].trim();
	}

	function parseIntOr(value, fallback) {
		const n = parseInt(value, 10);
		return isNaN(n) ? fallback : n;
	}

	/* ------------------------------------------------------------------ *
	 * Date placeholders - port of ReplaceDate
	 *
	 * {Name} prints the default format; {Name:dd.MM.yyyy} prints a custom one. A missing
	 * date blanks the placeholder entirely rather than leaving it on the label. Y and D are
	 * folded to lower case so DD.MM.YYYY works, which is what most people type.
	 * ------------------------------------------------------------------ */

	// Longest first within each letter, so dd is preferred over d.
	const DATE_TOKENS = [
		"yyyy", "yyy", "yy", "y",
		"MMMM", "MMM", "MM", "M",
		"dddd", "ddd", "dd", "d",
		"HH", "H", "hh", "h",
		"mm", "m", "ss", "s",
		"fff", "ff", "f", "tt", "t",
	];

	function replaceDate(text, name, date, defaultFormat) {
		const pattern = new RegExp("\\{" + name + "(?::([^{}]*))?\\}", "g");
		return (text || "").replace(pattern, function (whole, requested) {
			if (!date) return "";
			const format = String(requested || "").replace(/Y/g, "y").replace(/D/g, "d");
			return format.length === 0 ? standardDate(date, defaultFormat) : customDate(date, format);
		});
	}

	function standardDate(d, format) {
		// "g" is short date plus short time, "d" short date. The preview uses the browser
		// locale where the builder uses the device's, for the same reason: a stand-in.
		if (format === "g") {
			return (
				d.toLocaleDateString() +
				" " +
				d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			);
		}
		return d.toLocaleDateString();
	}

	function customDate(d, format) {
		let out = "";
		let i = 0;
		while (i < format.length) {
			const ch = format[i];

			// \x and 'literal' both escape, as they do in .NET custom formats.
			if (ch === "\\" && i + 1 < format.length) {
				out += format[i + 1];
				i += 2;
				continue;
			}
			if (ch === "'" || ch === '"') {
				const close = format.indexOf(ch, i + 1);
				if (close < 0) {
					out += format.slice(i + 1);
					break;
				}
				out += format.slice(i + 1, close);
				i = close + 1;
				continue;
			}

			let token = null;
			for (let t = 0; t < DATE_TOKENS.length; t++) {
				if (DATE_TOKENS[t][0] === ch && format.startsWith(DATE_TOKENS[t], i)) {
					token = DATE_TOKENS[t];
					break;
				}
			}
			if (token === null) {
				// Separators and anything else print as written. The builder formats with
				// the invariant culture precisely so / and : are not swapped for the
				// phone's own separators.
				out += ch;
				i++;
				continue;
			}
			out += formatDateToken(d, token);
			i += token.length;
		}
		return out;
	}

	function formatDateToken(d, token) {
		const pad = (n, width) => String(n).padStart(width, "0");
		const hour12 = ((d.getHours() + 11) % 12) + 1;
		switch (token) {
			case "yyyy": return pad(d.getFullYear(), 4);
			case "yyy": return pad(d.getFullYear(), 3);
			case "yy": return pad(d.getFullYear() % 100, 2);
			case "y": return String(d.getFullYear() % 100);
			// Month and day names come out English because the builder formats them with
			// the invariant culture.
			case "MMMM": return d.toLocaleString("en-US", { month: "long" });
			case "MMM": return d.toLocaleString("en-US", { month: "short" });
			case "MM": return pad(d.getMonth() + 1, 2);
			case "M": return String(d.getMonth() + 1);
			case "dddd": return d.toLocaleString("en-US", { weekday: "long" });
			case "ddd": return d.toLocaleString("en-US", { weekday: "short" });
			case "dd": return pad(d.getDate(), 2);
			case "d": return String(d.getDate());
			case "HH": return pad(d.getHours(), 2);
			case "H": return String(d.getHours());
			case "hh": return pad(hour12, 2);
			case "h": return String(hour12);
			case "mm": return pad(d.getMinutes(), 2);
			case "m": return String(d.getMinutes());
			case "ss": return pad(d.getSeconds(), 2);
			case "s": return String(d.getSeconds());
			case "fff": return pad(d.getMilliseconds(), 3);
			case "ff": return pad(Math.floor(d.getMilliseconds() / 10), 2);
			case "f": return String(Math.floor(d.getMilliseconds() / 100));
			case "tt": return d.getHours() < 12 ? "AM" : "PM";
			case "t": return d.getHours() < 12 ? "A" : "P";
			default: return token;
		}
	}

	// A bare YYYY-MM-DD is parsed by Date as UTC midnight, which renders as the previous
	// day everywhere west of UTC, so pull the parts out and build a local date instead.
	// These are calendar dates with no timezone attached.
	function parseLocalDate(value) {
		if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
		const text = String(value == null ? "" : value).trim();
		if (!text) return null;

		const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (ymd) {
			const local = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
			return isNaN(local.getTime()) ? null : local;
		}
		const parsed = new Date(text);
		return isNaN(parsed.getTime()) ? null : parsed;
	}

	// C# "g" - short date plus short time in the device culture. The preview uses the
	// browser locale for the same reason: it is a stand-in, not a contract.
	function formatShortDateTime(d) {
		return (
			d.toLocaleDateString() +
			" " +
			d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		);
	}

	// C# "d" - short date.
	//
	// A bare YYYY-MM-DD is parsed by Date as UTC midnight, which then renders as the
	// previous day everywhere west of UTC - so a discount ending on the 30th previewed as
	// the 29th. Pull the parts out and build a local date instead. Dates reaching here
	// come from an <input type="date"> or an ERPNext date field, both of which are plain
	// calendar dates with no timezone attached.
	function formatShortDate(value) {
		if (value instanceof Date) {
			return isNaN(value.getTime()) ? "" : value.toLocaleDateString();
		}

		const text = String(value == null ? "" : value).trim();
		const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (ymd) {
			const local = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
			return isNaN(local.getTime()) ? text : local.toLocaleDateString();
		}

		const parsed = new Date(text);
		return isNaN(parsed.getTime()) ? text : parsed.toLocaleDateString();
	}

	return {
		DOTS_PER_MM: DOTS_PER_MM,
		TSPL_FONTS: TSPL_FONTS,
		FIELD_LABEL_FONTS: FIELD_LABEL_FONTS,
		HRI_HEIGHT: HRI_HEIGHT,
		build: build,
		formatNumber: formatNumber,
		evaluatePlaceholderMath: evaluatePlaceholderMath,
		splitTextByCharLimit: splitTextByCharLimit,
		resolveImageSize: resolveImageSize,
		sanitizeForTspl: sanitizeForTspl,
	};
})();
