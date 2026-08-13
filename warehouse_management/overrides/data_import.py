import frappe
from frappe import _
from rq.timeouts import JobTimeoutException

from frappe.core.doctype.data_import.data_import import DataImport
from frappe.core.doctype.data_import.importer import Importer, get_id_field
from frappe.core.doctype.version.version import get_diff
from frappe.utils.background_jobs import enqueue, is_job_enqueued
from frappe.utils.scheduler import is_scheduler_inactive


class CustomImporter(Importer):
    """
    Custom Data Importer.

    Difference from standard Frappe behavior:
    If an Update Existing Records row contains no changes,
    treat it as successful instead of raising:
        "No changes to update"
    """

    def update_record(self, doc):
        id_field = get_id_field(self.doctype)
        docname = doc.get(id_field.fieldname)

        existing_doc = frappe.get_doc(self.doctype, docname)
        updated_doc = frappe.get_doc(self.doctype, docname)

        updated_doc.update(doc)

        # There are actual changes
        if get_diff(existing_doc, updated_doc):
            updated_doc.flags.updater_reference = {
                "doctype": self.data_import.doctype,
                "docname": self.data_import.name,
                "label": _("via Data Import"),
            }

            updated_doc.save()

            return updated_doc

        # No changes:
        # Return existing document instead of throwing
        # "No changes to update"
        return existing_doc


class CustomDataImport(DataImport):

    def get_importer(self):
        return CustomImporter(
            self.reference_doctype,
            data_import=self,
        )

    def start_import(self):
        """
        Override this because standard Frappe's background job
        creates the standard Importer directly.
        """

        run_now = frappe.flags.in_test or frappe.conf.developer_mode

        if is_scheduler_inactive() and not run_now:
            frappe.throw(
                _("Scheduler is inactive. Cannot import data."),
                title=_("Scheduler Inactive"),
            )

        job_id = f"data_import::{self.name}"

        if not is_job_enqueued(job_id):
            enqueue(
                custom_start_import,
                queue="default",
                timeout=10000,
                event="data_import",
                job_id=job_id,
                data_import=self.name,
                now=run_now,
            )

            return True

        return False


def custom_start_import(data_import):
    """
    Background job used by CustomDataImport.
    """

    data_import_doc = frappe.get_doc(
        "Data Import",
        data_import,
    )

    try:
        importer = data_import_doc.get_importer()
        importer.import_data()

    except JobTimeoutException:
        frappe.db.rollback()
        data_import_doc.db_set("status", "Timed Out")

    except Exception:
        frappe.db.rollback()
        data_import_doc.db_set("status", "Error")
        data_import_doc.log_error("Data import failed")

    finally:
        frappe.flags.in_import = False

        frappe.publish_realtime(
            "data_import_refresh",
            {
                "data_import": data_import_doc.name
            },
        )
