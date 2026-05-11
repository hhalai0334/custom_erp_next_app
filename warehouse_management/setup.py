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

    shortcuts = [
        {
            "label": "App Settings",
            "link_to": "Appsettings",
            "type": "DocType",
            "icon": "settings",
            "color": "blue",
        },
        {
            "label": "Item",
            "link_to": "Item",
            "type": "DocType",
            "icon": "package",
            "color": "green",
        },
        {
            "label": "Inventory",
            "link_to": "Inventory",
            "type": "DocType",
            "icon": "list",
            "color": "orange",
        },
        {
            "label": "Warehouse",
            "link_to": "Warehouse",
            "type": "DocType",
            "icon": "home",
            "color": "red",
        },
    ]

    cards = [
        {
            "name": "Settings",
            "links": [
                {
                    "label": "App Settings",
                    "type": "DocType",
                    "link_to": "Appsettings",
                    "description": "Configure global app settings",
                },
                {
                    "label": "User Settings",
                    "type": "DocType",
                    "link_to": "Usersettings",
                    "description": "Per-user preferences",
                },
            ],
        },
        {
            "name": "Inventory",
            "links": [
                {
                    "label": "Item",
                    "type": "DocType",
                    "link_to": "Item",
                    "description": "Manage items",
                },
                {
                    "label": "Inventory List",
                    "type": "DocType",
                    "link_to": "Inventory",
                    "description": "View all inventory entries",
                },
                {
                    "label": "Warehouse List",
                    "type": "DocType",
                    "link_to": "Warehouse",
                    "description": "Manage warehouses",
                },
                {
                    "label": "Warehouse Stock",
                    "type": "DocType",
                    "link_to": "Warehousestock",
                    "description": "Stock levels per warehouse",
                },
            ],
        },
        {
            "name": "Pricing",
            "links": [
                {
                    "label": "User Settings",
                    "type": "DocType",
                    "link_to": "Usersettings",
                    "description": "Per-user preferences",
                },
                {
                    "label": "Item Discount",
                    "type": "DocType",
                    "link_to": "Item Discount",
                    "description": "Item-level discounts",
                },
                {
                    "label": "Discount Labels",
                    "type": "DocType",
                    "link_to": "Discount Labels",
                    "description": "Manage discount label definitions",
                },
            ],
        },
    ]

    content = []

    # Shortcuts row
    for index, shortcut in enumerate(shortcuts, start=1):
        content.append(
            {
                "id": f"wm-shortcut-{index}",
                "type": "shortcut",
                "data": {
                    "shortcut_name": shortcut["label"],
                    "col": 3,
                },
            }
        )

    # Cards
    for card_index, card in enumerate(cards, start=1):
        content.append(
            {
                "id": f"wm-card-{card_index}",
                "type": "card",
                "data": {
                    "card_name": card["name"],
                    "col": 4,
                    "links": [
                        {
                            "id": f"wm-card-{card_index}-link-{link_index}",
                            "label": link["label"],
                            "type": link["type"],
                            "link_to": link["link_to"],
                            "description": link.get("description", ""),
                        }
                        for link_index, link in enumerate(card["links"], start=1)
                    ],
                },
            }
        )

    if frappe.db.exists("Workspace", name):
        ws = frappe.get_doc("Workspace", name)
    else:
        ws = frappe.new_doc("Workspace")
        ws.name = name

    ws.update(
        {
            "label": name,
            "title": name,
            "module": "Warehouse Management",
            "icon": "tool",
            "indicator_color": "blue",
            "is_standard": 1,
            "public": 1,
            "short_name": "WM",
            "sequence_id": 1.0,
            "content": json.dumps(content),
        }
    )

    # Reset and recreate shortcuts so updates are applied cleanly
    ws.set("shortcuts", [])

    for shortcut in shortcuts:
        ws.append(
            "shortcuts",
            {
                "label": shortcut["label"],
                "link_to": shortcut["link_to"],
                "type": shortcut["type"],
                "icon": shortcut["icon"],
                "color": shortcut["color"],
            },
        )

    ws.save(ignore_permissions=True)
    frappe.clear_cache()
