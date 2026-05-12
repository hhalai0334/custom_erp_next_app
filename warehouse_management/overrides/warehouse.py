from erpnext.stock.doctype.warehouse.warehouse import Warehouse
import frappe


class CustomWarehouse(Warehouse):
    def validate_warehouse_price_flags(doc, method=None):
        if doc.custom_show_warehouse_pricing and doc.custom_show_wholesale_price:
            frappe.throw(
                _("Only one of Warehouse Pricing or Wholesale Price can be selected.")
            )

    def autoname(self):
        if not self.custom_warehouse_code:
            frappe.throw("Custom Warehouse Code is required")

        self.name = self.custom_warehouse_code
        frappe.msgprint(self.name)
