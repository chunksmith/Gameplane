import { useState } from "react";
import {
  ArrowRightLeft,
  Copy,
  Eraser,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { buttonVariants } from "@heroui/styles";
import type { GameServer } from "@/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { useResourceTarget, useResourceAccess, type ResourceTarget, type ServerAccess } from "@/lib/resourceTarget";
import { cn } from "@/lib/utils";

import { CloneServerDialog } from "./CloneServerDialog";
import { DeleteServerDialog } from "./DeleteServerDialog";
import { TransferServerDialog } from "./TransferServerDialog";
import { WipeServerDialog } from "./WipeServerDialog";

interface Props {
  target?: ResourceTarget;
  access?: ServerAccess;
  gs: GameServer;
  onDeleted?: () => void;
  onTransferred?: () => void;
  size?: "sm" | "md";
  className?: string;
}

export function ServerActionsMenu({ gs, onDeleted, onTransferred, target: explicitTarget, access: explicitAccess, size, className }: Props) {
  const ns = gs.metadata.namespace;
  const target = useResourceTarget({ name: gs.metadata.name, namespace: ns }, explicitTarget);
  const access = useResourceAccess(explicitAccess);
  const canClone = access?.canWrite === true;
  const canManage = access?.canDelete === true;
  const canDelete = access?.canDelete === true;

  const [cloneOpen, setCloneOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(buttonVariants({ isIconOnly: true, variant: "ghost", size }), className)}
          aria-label="Server actions"
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            icon={<Copy className="h-4 w-4" />}
            label="Clone server"
            onSelect={() => setCloneOpen(true)}
            disabled={!canClone}
            hint={canClone ? undefined : "Requires operator role"}
          />
          <DropdownMenuItem
            icon={<ArrowRightLeft className="h-4 w-4" />}
            label="Transfer ownership"
            onSelect={() => setTransferOpen(true)}
            disabled={!canManage}
            hint={canManage ? undefined : "Requires owner or operator role"}
          />
          <DropdownMenuItem
            icon={<Eraser className="h-4 w-4" />}
            label="Wipe world data"
            onSelect={() => setWipeOpen(true)}
            disabled={!canManage}
            hint={canManage ? undefined : "Requires owner or operator role"}
            destructive
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<Trash2 className="h-4 w-4" />}
            label="Delete server"
            onSelect={() => setDeleteOpen(true)}
            disabled={!canDelete}
            destructive
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <CloneServerDialog
        target={target}
        open={cloneOpen}
        onOpenChange={setCloneOpen}
        sourceName={gs.metadata.name}
        ns={ns}
      />
      <TransferServerDialog
        target={target}
        name={gs.metadata.name}
        ns={ns}
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onTransferred={onTransferred}
      />
      <WipeServerDialog
        target={target}
        name={gs.metadata.name}
        ns={ns}
        open={wipeOpen}
        onOpenChange={setWipeOpen}
      />
      <DeleteServerDialog
        target={target}
        name={gs.metadata.name}
        ns={ns}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={onDeleted}
      />
    </>
  );
}
