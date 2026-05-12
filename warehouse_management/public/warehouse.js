frappe.ui.form.on('Warehouse', {
    custom_show_warehouse_pricing(frm) {
        if (frm.doc.custom_show_warehouse_pricing) {
            frm.set_value('custom_show_wholesale_price', 0);
        }
    },

    custom_show_wholesale_price(frm) {
        if (frm.doc.custom_show_wholesale_price) {
            frm.set_value('custom_show_warehouse_pricing', 0);
        }
    },

    validate(frm) {
        if (
            frm.doc.custom_show_warehouse_pricing &&
            frm.doc.custom_show_wholesale_price
        ) {
            frappe.throw(__('Only one of Warehouse Pricing or Wholesale Price can be selected.'));
        }
    }
});
