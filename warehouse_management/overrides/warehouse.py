from erpnext.stock.doctype.warehouse.warehouse import Warehouse
import frappe
from frappe import _


class CustomWarehouse(Warehouse):

    def validate(self):
        super().validate()
        self.validate_warehouse_price_flags()

    def validate_warehouse_price_flags(self):
        if self.custom_show_warehouse_pricing and self.custom_show_wholesale_price:
            frappe.throw(
                _("Only one of Warehouse Pricing or Wholesale Price can be selected.")
            )

    def autoname(self):
        if not self.custom_warehouse_code:
            frappe.throw("Custom Warehouse Code is required")
        if self.custom_show_warehouse_pricing and self.custom_show_wholesale_price:
            frappe.throw(
                _("Only one of Warehouse Pricing or Wholesale Price can be selected.")
            )
        self.name = self.custom_warehouse_code
        frappe.msgprint(self.name)
