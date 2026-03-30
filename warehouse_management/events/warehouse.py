# warehouse_management/events/warehouse.py

import frappe

def before_insert_warehouse(doc, method=None):
    frappe.msgprint("Warehouse event triggered")
    if not doc.custom_warehouse_code:
        frappe.throw("Custom Warehouse Code is required")

    doc.name = doc.custom_warehouse_code

def before_naming(doc, method=None):
    doc.name = doc.custom_warehouse_code
