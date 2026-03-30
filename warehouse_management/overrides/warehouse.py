from erpnext.stock.doctype.warehouse.warehouse import Warehouse
import frappe

class CustomWarehouse(Warehouse):

    def autoname(self):
        if not self.custom_warehouse_code:
            frappe.throw("Custom Warehouse Code is required")

        self.name = self.custom_warehouse_code
        frappe.msgprint(self.name)
