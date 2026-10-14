import { useState } from "react";
import {
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Label,
  Description,
  Select,
  ListBox,
  ListBoxItem,
} from "@heroui/react";

const MIN_PASSWORD_LEN = 12;

export interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvite?: (
    username: string,
    displayName: string,
    email: string,
    password: string,
    role?: string,
  ) => void;
  isLoading?: boolean;
  /**
   * Role names offered in a "Role" select. When omitted (or empty), no role
   * field is rendered and `onInvite` is called with its original 4-arg
   * signature — this keeps every pre-existing caller/test unaffected.
   */
  roles?: string[];
  /**
   * When true, display name/email/password are optional (matching the
   * "create a local account, leave password blank for an OIDC invite"
   * flow) — only username is required, and password is validated for
   * minimum length only when non-empty. Defaults to false, preserving the
   * dialog's original all-fields-required behavior.
   */
  contactFieldsOptional?: boolean;
  /**
   * When true, the submit button is preemptively disabled while the
   * username is empty or the password is present-but-too-short, instead of
   * relying on a click to reveal the validation error. Defaults to false,
   * preserving the original click-to-validate behavior.
   */
  disableSubmitUntilValid?: boolean;
  /** Error text from an external (API) failure, shown alongside client validation. */
  apiError?: string;
  submitLabel?: string;
}

function defaultRole(roles?: string[]): string {
  return ["member", "viewer"].find((role) => roles?.includes(role)) ?? roles?.[0] ?? "viewer";
}

export function InviteUserDialog({
  open,
  onOpenChange,
  onInvite,
  isLoading = false,
  roles,
  contactFieldsOptional = false,
  disableSubmitUntilValid = false,
  apiError,
  submitLabel = "Invite user",
}: InviteUserDialogProps) {
  const hasRoles = !!roles && roles.length > 0;
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [chosenRole, setChosenRole] = useState<string>();
  const role = chosenRole ?? defaultRole(roles);
  const [error, setError] = useState<string>("");

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LEN;
  const liveError = disableSubmitUntilValid && passwordTooShort ? `At least ${MIN_PASSWORD_LEN} characters.` : "";
  const submitDisabled =
    isLoading || (disableSubmitUntilValid && (!username.trim() || passwordTooShort));

  const handleInvite = () => {
    setError("");
    if (!username.trim()) {
      setError("Username is required");
      return;
    }
    if (!contactFieldsOptional) {
      if (!displayName.trim()) {
        setError("Display name is required");
        return;
      }
      if (!email.trim()) {
        setError("Email is required");
        return;
      }
      if (!password.trim()) {
        setError("Password is required");
        return;
      }
    }
    if (passwordTooShort) {
      setError(
        contactFieldsOptional
          ? `At least ${MIN_PASSWORD_LEN} characters.`
          : `Password must be at least ${MIN_PASSWORD_LEN} characters`,
      );
      return;
    }
    if (hasRoles) {
      onInvite?.(username, displayName, email, password, role);
    } else {
      onInvite?.(username, displayName, email, password);
    }
  };

  const handleClose = () => {
    setUsername("");
    setDisplayName("");
    setEmail("");
    setPassword("");
    setChosenRole(undefined);
    setError("");
    onOpenChange(false);
  };

  const displayError = error || liveError || apiError;

  return (
    <Modal isOpen={open} onOpenChange={handleClose}>
      <ModalBackdrop isDismissable={!isLoading} isKeyboardDismissDisabled={isLoading}>
        <ModalContainer>
          <ModalDialog className="w-[480px] max-w-[480px] rounded-xl">
            <ModalHeader>
              <ModalHeading>Invite user</ModalHeading>
              {contactFieldsOptional && (
                <Description className="text-sm leading-[21px] text-muted">
                  Create a local account. Leave password blank to send an OIDC invite later.
                </Description>
              )}
            </ModalHeader>

            <ModalBody className="gap-3">

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-username" className="text-xs">
                Username
              </Label>
              <Input
                id="invite-username"
                fullWidth
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="alice"
                disabled={isLoading}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-display-name" className="text-xs">
                Display name
              </Label>
              <Input
                id="invite-display-name"
                fullWidth
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Alice Operator"
                disabled={isLoading}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email" className="text-xs">
                Email
              </Label>
              <Input
                id="invite-email"
                fullWidth
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@example.com"
                type="email"
                disabled={isLoading}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-password" className="text-xs">
                Initial password
              </Label>
              <Input
                id="invite-password"
                fullWidth
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${MIN_PASSWORD_LEN} characters`}
                type="password"
                disabled={isLoading}
              />
            </div>

            {hasRoles && (
              <div>
                <Select className="flex flex-col gap-1.5" value={role} onChange={(v) => setChosenRole(String(v))} isDisabled={isLoading}>
                  <Label htmlFor="invite-role" className="text-xs">
                    Role
                  </Label>
                  <Select.Trigger
                    id="invite-role"
                    className="w-full items-center rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-surface/80"
                  >
                    <Select.Value className="text-[var(--field-placeholder)]" />
                    <Select.Indicator className="ml-auto h-4 w-4" />
                  </Select.Trigger>
                  <Select.Popover className="rounded border border-border">
                    <ListBox className="p-0" aria-label="Role">
                      {roles?.map((r) => (
                        <ListBoxItem key={r} id={r}>
                          {r}
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            )}

            {displayError && (<p className="text-xs text-danger" role="alert">{displayError}</p>)}
          </ModalBody>

          <ModalFooter className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" className="text-xs" onPress={handleClose} isDisabled={isLoading}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="text-xs"
              isDisabled={submitDisabled}
              onPress={handleInvite}
            >
              {isLoading ? "Inviting…" : submitLabel}
            </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}
