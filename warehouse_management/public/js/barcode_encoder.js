// Copyright (c) 2026, h.halai0334@gmail.com and contributors
// For license information, please see license.txt
//
// Code 128 and EAN-13 encoders for the label preview.
//
// The preview encodes the barcode properly instead of drawing a placeholder block
// because the width is the whole point: a BARCODE command whose content grows by a few
// characters silently runs off the edge of the label, and that is exactly the mistake
// the preview exists to catch. Each encoder returns the module pattern; the caller
// multiplies by the TSPL narrow parameter to get dots.

frappe.provide("warehouse_management.barcode");

warehouse_management.barcode = (function () {
	// Element widths for Code 128 values 0-106, bar first, alternating bar/space.
	const CODE128_PATTERNS = [
		"212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
		"132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
		"123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
		"311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
		"232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
		"231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
		"313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
		"331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
		"111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
		"122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
		"111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
		"421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
		"114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
		"211214", "211232", "2331112",
	];

	const START_B = 104;
	const START_C = 105;
	const CODE_B = 100;
	const CODE_C = 99;
	const STOP = 106;

	// EAN-13 digit encodings, 7 modules each.
	const EAN_L = [
		"0001101", "0011001", "0010011", "0111101", "0100011",
		"0110001", "0101111", "0111011", "0110111", "0001011",
	];
	const EAN_G = [
		"0100111", "0110011", "0011011", "0100001", "0011101",
		"0111001", "0000101", "0010001", "0001001", "0010111",
	];
	const EAN_R = [
		"1110010", "1100110", "1101100", "1000010", "1011100",
		"1001110", "1010000", "1000100", "1001000", "1110100",
	];
	// Which of the first six digits use the G set, selected by the leading digit.
	const EAN_PARITY = [
		"LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
		"LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL",
	];

	function isDigit(c) {
		return c >= "0" && c <= "9";
	}

	// Values for Code 128 with automatic B/C switching, the way the printer does it.
	// Returns null when the content cannot be encoded (any character outside ASCII
	// 32-126, which is the printable range of subset B).
	function code128Values(data) {
		const codes = [];
		let mode;
		let i = 0;

		const digitsAt = function (p) {
			let n = 0;
			while (p + n < data.length && isDigit(data[p + n])) n++;
			return n;
		};

		const leading = digitsAt(0);
		if (leading >= 4 || (leading === data.length && leading >= 2 && leading % 2 === 0)) {
			mode = "C";
			codes.push(START_C);
		} else {
			mode = "B";
			codes.push(START_B);
		}

		while (i < data.length) {
			if (mode === "C") {
				const n = digitsAt(i);
				if (n >= 2) {
					// Subset C packs digits in pairs, so an odd run leaves one behind.
					const take = n % 2 === 0 ? n : n - 1;
					for (let k = 0; k < take; k += 2) {
						codes.push(parseInt(data.substr(i + k, 2), 10));
					}
					i += take;
					if (i < data.length) {
						codes.push(CODE_B);
						mode = "B";
					}
				} else {
					codes.push(CODE_B);
					mode = "B";
				}
			} else {
				const n = digitsAt(i);
				if (n >= 6 && n % 2 === 0) {
					codes.push(CODE_C);
					mode = "C";
				} else {
					const c = data.charCodeAt(i);
					if (c < 32 || c > 126) return null;
					codes.push(c - 32);
					i++;
				}
			}
		}

		let sum = codes[0];
		for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
		codes.push(sum % 103);
		codes.push(STOP);
		return codes;
	}

	// Returns { modules: [{bar, width}], width } in module units, or { error } when the
	// content cannot be encoded in this symbology.
	function code128(data) {
		if (!data || !data.length) return { error: "Code 128 needs some content." };

		const values = code128Values(data);
		if (!values) {
			return {
				error: "Code 128 subset B prints ASCII 32-126 only; this content has characters outside it.",
			};
		}

		const modules = [];
		let width = 0;
		for (const value of values) {
			const pattern = CODE128_PATTERNS[value];
			for (let k = 0; k < pattern.length; k++) {
				const w = parseInt(pattern[k], 10);
				modules.push({ bar: k % 2 === 0, width: w });
				width += w;
			}
		}
		return { modules: modules, width: width, hri: data };
	}

	function eanChecksum(digits12) {
		let sum = 0;
		for (let i = 0; i < 12; i++) {
			sum += parseInt(digits12[i], 10) * (i % 2 === 0 ? 1 : 3);
		}
		return (10 - (sum % 10)) % 10;
	}

	function ean13(data) {
		const raw = String(data || "").trim();
		if (!/^\d+$/.test(raw)) {
			return { error: "EAN-13 needs digits only; this content has other characters." };
		}
		if (raw.length !== 12 && raw.length !== 13) {
			return {
				error: "EAN-13 needs 12 or 13 digits; this content has " + raw.length + ".",
			};
		}

		const base = raw.slice(0, 12);
		const check = eanChecksum(base);
		if (raw.length === 13 && parseInt(raw[12], 10) !== check) {
			return {
				error: "EAN-13 check digit is wrong: " + raw + " should end in " + check + ".",
			};
		}
		const digits = base + check;

		let bits = "101";
		const parity = EAN_PARITY[parseInt(digits[0], 10)];
		for (let i = 1; i <= 6; i++) {
			const d = parseInt(digits[i], 10);
			bits += parity[i - 1] === "L" ? EAN_L[d] : EAN_G[d];
		}
		bits += "01010";
		for (let i = 7; i <= 12; i++) {
			bits += EAN_R[parseInt(digits[i], 10)];
		}
		bits += "101";

		// Collapse the bit string into runs so the canvas draws whole bars.
		const modules = [];
		let i = 0;
		while (i < bits.length) {
			let run = 1;
			while (i + run < bits.length && bits[i + run] === bits[i]) run++;
			modules.push({ bar: bits[i] === "1", width: run });
			i += run;
		}
		return { modules: modules, width: bits.length, hri: digits };
	}

	function encode(symbology, data) {
		const sym = String(symbology || "128").toUpperCase();
		if (sym === "EAN13" || sym === "EAN-13") return ean13(data);
		if (sym === "128" || sym === "CODE128") return code128(data);
		return { error: 'The preview cannot draw symbology "' + symbology + '" yet.' };
	}

	return { encode: encode, code128: code128, ean13: ean13 };
})();
