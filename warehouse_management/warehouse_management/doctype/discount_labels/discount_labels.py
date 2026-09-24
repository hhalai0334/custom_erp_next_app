# Copyright (c) 2026, h.halai0334@gmail.com and contributors
# For license information, please see license.txt

import os
from urllib.parse import unquote, urlparse

import frappe
from frappe import _
from frappe.model.document import Document


class DiscountLabels(Document):
	def validate(self):
		self.validate_image_items()

	def validate_image_items(self):
		"""Image rows are printed with TSPL's PUTBMP, which only takes a BMP.

		Any other format reaches the printer as an unprintable file and the row silently
		comes out blank, so reject it here where the mistake is still visible.
		"""
		for row in self.item_table or []:
			if row.item_select != "Image":
				continue

			if not row.item_image:
				frappe.throw(
					_("Row {0}: attach a .bmp image, or change the Type.").format(row.idx)
				)

			extension = image_extension(row.item_image)
			if extension != ".bmp":
				frappe.throw(
					_(
						"Row {0}: the printer prints images with PUTBMP, which only takes a "
						".bmp file. {1} was attached instead."
					).format(row.idx, extension or _("A file with no extension"))
				)


def image_extension(file_url):
	"""Lower-cased extension of an attachment URL, ignoring any query string."""
	path = urlparse(file_url or "").path
	return os.path.splitext(unquote(path))[1].lower()
