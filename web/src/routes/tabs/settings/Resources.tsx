import { useEffect } from "react";
import { Input } from "@heroui/react";
import type { ResourceRequirements } from "@/types";
import { isValidQuantity } from "@/lib/validation";
import { RequestLimitCard, resourcesValid } from "@/components/ui/RequestLimitCard";
import { Field } from "./Field";
import type { SectionProps } from "./types";
import { useOptionalIntl } from "@/lib/i18n/format";


export function ResourcesSection({ draft, onChange, template, onValidityChange }: SectionProps) {
  const intl = useOptionalIntl();
  const resources = draft.spec.resources ?? template?.spec.resources;
  const resourcesAreValid = resourcesValid(resources);

  useEffect(() => {
    onValidityChange?.(resourcesAreValid);
  }, [resourcesAreValid, onValidityChange]);

  const setResources = (next: ResourceRequirements) => {
    onChange({ ...draft, spec: { ...draft.spec, resources: next } });
  };

  const storage = draft.spec.storage ?? {};

  const setStorage = (next: typeof storage) => {
    const cleaned: typeof storage = {};
    if (next.size) cleaned.size = next.size;
    if (next.storageClassName) cleaned.storageClassName = next.storageClassName;
    if (next.mountPath) cleaned.mountPath = next.mountPath;
    onChange({
      ...draft,
      spec: {
        ...draft.spec,
        storage: Object.keys(cleaned).length ? cleaned : undefined,
      },
    });
  };

  const sizeValid = !storage.size || isValidQuantity(storage.size);

  return (
    <div className="space-y-6">
      <RequestLimitCard kind="cpu" resources={resources} onChange={setResources} />
      <RequestLimitCard kind="memory" resources={resources} onChange={setResources} />

      <section className="space-y-6 rounded-xl border border-border bg-card p-5">
        <Field
          label={intl.formatMessage({ id: "web.routes.tabs.settings.resources.storage_size", defaultMessage: "Storage size", description: "Resources: field label for the size of the server's persistent storage; the accessible name of its box is the same" })}
          hint={
            <>
              <div>{intl.formatMessage({ id: "web.routes.tabs.settings.resources.k8s_quantity_e_g_10gi_200gi", defaultMessage: "K8s quantity (e.g. 10Gi, 200Gi).", description: "Resources: hint under the storage size field saying the value is a Kubernetes quantity such as 10Gi or 200Gi; Kubernetes is a technical term" })}</div>
              <div className="pt-1">{intl.formatMessage(
                { id: "web.routes.tabs.settings.resources.resizing_requires_a_storageclass_with", defaultMessage: "Resizing requires a StorageClass with {setting}.", description: "Resources: hint under the storage size field saying resizing needs a StorageClass that allows volume expansion; {setting} is the allowVolumeExpansion: true field, shown in monospace" },
                { setting: <span className="font-mono">{intl.formatMessage({ id: "web.routes.tabs.settings.resources.allowvolumeexpansion_true", defaultMessage: "allowVolumeExpansion: true", description: "Resources: Kubernetes StorageClass field name shown in the storage size hint" })}</span> },
              )}
              </div>
            </>
          }
        >
          <Input
            type="text"
            value={storage.size ?? ""}
            onChange={(e) => setStorage({ ...storage, size: e.target.value || undefined })}
            placeholder={intl.formatMessage({ id: "web.routes.tabs.settings.resources.10gi", defaultMessage: "10Gi", description: "Resources: example placeholder in the storage size box; an example value, not a default" })}
            className={sizeValid ? "" : "border-danger focus:border-danger focus:ring-danger"}
            aria-label={intl.formatMessage({ id: "web.routes.tabs.settings.resources.storage_size", defaultMessage: "Storage size", description: "Resources: field label for the size of the server's persistent storage; the accessible name of its box is the same" })}
          />
          {!sizeValid && (
            <div className="pt-1 text-xs text-danger">{intl.formatMessage({ id: "web.routes.tabs.settings.resources.invalid_quantity_e_g_10gi", defaultMessage: "Invalid quantity (e.g. \"10Gi\").", description: "Resources: validation error under the storage size box when the value is not a valid quantity such as 10Gi" })}</div>
          )}
        </Field>

        <Field label={intl.formatMessage({ id: "web.routes.tabs.settings.resources.storageclass", defaultMessage: "StorageClass", description: "Resources: field label for the optional storage class that provides the server's storage; the hint below says blank uses the cluster default" })} hint={intl.formatMessage({ id: "web.routes.tabs.settings.resources.leave_blank_to_use_the_cluster_default", defaultMessage: "Leave blank to use the cluster default.", description: "Resources: hint under the StorageClass field saying a blank value uses the cluster default storage class" })}>
          <Input
            type="text"
            value={storage.storageClassName ?? ""}
            onChange={(e) =>
              setStorage({ ...storage, storageClassName: e.target.value || undefined })
            }
            placeholder={intl.formatMessage({ id: "web.routes.tabs.settings.resources.fast_ssd", defaultMessage: "fast-ssd", description: "Resources: example placeholder in the StorageClass box; an example class name, not a default" })}
            aria-label={intl.formatMessage({ id: "web.routes.tabs.settings.resources.storageclass", defaultMessage: "StorageClass", description: "Resources: field label for the optional storage class that provides the server's storage; the hint below says blank uses the cluster default" })}
          />
        </Field>
      </section>
    </div>
  );
}
