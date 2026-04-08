import frappe
import json


def after_install():
    create_workspace()
    frappe.db.commit()


def after_migrate():
    create_workspace()
    frappe.db.commit()


def before_uninstall():
    if frappe.db.exists("Workspace", "Warehouse Management"):
        frappe.delete_doc("Workspace", "Warehouse Management", force=True)
        frappe.db.commit()


def create_workspace():
    name = "Warehouse Management"

    # In ERPNext 15 the entire workspace layout is one JSON blob in `content`
    content = json.dumps([
        # ── Shortcuts row ────────────────────────────────────────────────
        {
            "id": "wm-shortcut-1",
            "type": "shortcut",
            "data": {"shortcut_name": "App Settings",   "col": 3}
        },
        {
            "id": "wm-shortcut-2",
            "type": "shortcut",
            "data": {"shortcut_name": "Item",           "col": 3}
        },
        {
            "id": "wm-shortcut-3",
            "type": "shortcut",
            "data": {"shortcut_name": "Inventory",      "col": 3}
        },
        {
            "id": "wm-shortcut-4",
            "type": "shortcut",
            "data": {"shortcut_name": "Warehouse",      "col": 3}
        },

        # ── Settings card ────────────────────────────────────────────────
        {
            "id": "wm-card-settings",
            "type": "card",
            "data": {
                "card_name": "Settings",
                "col": 4,
                "links": [
                    {
                        "id": "wm-link-appsettings",
                        "label": "App Settings",
                        "type": "DocType",
                        "link_to": "Appsettings",
                        "description": "Configure global app settings"
                    },
                    {
                        "id": "wm-link-usersettings",
                        "label": "User Settings",
                        "type": "DocType",
                        "link_to": "Usersettings",
                        "description": "Per-user preferences"
                    }
                ]
            }
        },

        # ── Inventory card ───────────────────────────────────────────────
        {
            "id": "wm-card-inventory",
            "type": "card",
            "data": {
                "card_name": "Inventory",
                "col": 4,
                "links": [
                    {
                        "id": "wm-link-item",
                        "label": "Item",
                        "type": "DocType",
                        "link_to": "Item",
                        "description": "Manage items"
                    },
                    {
                        "id": "wm-link-inventory",
                        "label": "Inventory List",
                        "type": "DocType",
                        "link_to": "Inventory",
                        "description": "View all inventory entries"
                    },
                    {
                        "id": "wm-link-warehouse",
                        "label": "Warehouse List",
                        "type": "DocType",
                        "link_to": "Warehouse",
                        "description": "Manage warehouses"
                    },
                    {
                        "id": "wm-link-warehousestock",
                        "label": "Warehouse Stock",
                        "type": "DocType",
                        "link_to": "Warehousestock",
                        "description": "Stock levels per warehouse"
                    }
                ]
            }
        },

        # ── Pricing card ─────────────────────────────────────────────────
        {
            "id": "wm-card-pricing",
            "type": "card",
            "data": {
                "card_name": "Pricing",
                "col": 4,
                "links": [
                    {
                        "id": "wm-link-usersettings2",
                        "label": "User Settings",
                        "type": "DocType",
                        "link_to": "Usersettings",
                        "description": "Per-user preferences"
                    },
                    {
                        "id": "wm-link-discount",
                        "label": "Item Discount",
                        "type": "DocType",
                        "link_to": "Item Discount",
                        "description": "Item-level discounts"
                    },
                    {
                        "id": "wm-link-labels",
                        "label": "Discount Labels",
                        "type": "DocType",
                        "link_to": "Discount Labels",
                        "description": "Manage discount label definitions"
                    }
                ]
            }
        }
    ])

    if frappe.db.exists("Workspace", name):
        ws = frappe.get_doc("Workspace", name)
    else:
        ws = frappe.new_doc("Workspace")
        ws.name = name

    ws.update({
        "label": name,
        "title": name,
        "module": "Warehouse Management",
        "icon": "tool",
        "indicator_color": "blue",
        "is_standard": 1,
        "public": 1,
        "short_name": "WM",
        "sequence_id": 1.0,
        "content": content,
    })

    ws.set("shortcuts", [
        {
            "label": "App Settings",
            "link_to": "Appsettings",
            "type": "DocType",
            "icon": "settings",
            "color": "blue"
        },
        {
            "label": "Item",
            "link_to": "Item",
            "type": "DocType",
            "icon": "package",
            "color": "green"
        },
        {
            "label": "Inventory",
            "link_to": "Inventory",
            "type": "DocType",
            "icon": "list",
            "color": "orange"
        },
        {
            "label": "Warehouse",
            "link_to": "Warehouse",
            "type": "DocType",
            "icon": "home",
            "color": "red"
        },
    ])

    ws.save(ignore_permissions=True)
    frappe.clear_cache()
