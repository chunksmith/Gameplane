import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/render";
import { UsersPage } from "./Users";

const list = vi.fn();
const rolesList = vi.fn();
vi.mock("@/lib/endpoints", () => ({
  Users: {
    list: () => list(),
    update: vi.fn(),
    remove: vi.fn(),
    resetPassword: vi.fn(),
    create: vi.fn(),
    bindings: () => Promise.resolve([]),
    addBinding: vi.fn(),
    removeBinding: vi.fn(),
  },
  Roles: {
    list: () => rolesList(),
    catalog: () => Promise.resolve({ groups: [] }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  useMe: () => ({
    data: {
      id: 1, username: "root", displayName: "Root", email: "r@x",
      role: "admin", permissions: { "*": ["*"] },
    },
    error: null,
    isLoading: false,
  }),
}));
const tabSearch = vi.hoisted(() => ({ tab: undefined as string | undefined, listeners: new Set<() => void>() }));
vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    Link: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) => (
      <a {...rest}>{children}</a>
    ),
    useSearch: () => ({
      tab: useSyncExternalStore(
        (listener) => {
          tabSearch.listeners.add(listener);
          return () => {
            tabSearch.listeners.delete(listener);
          };
        },
        () => tabSearch.tab,
      ),
    }),
    useNavigate: () => (options: { search?: { tab?: string } }) => {
      tabSearch.tab = options.search?.tab;
      tabSearch.listeners.forEach((listener) => listener());
      return Promise.resolve();
    },
  };
});

function renderPage() {
  return renderWithQuery(<UsersPage />);
}

beforeEach(() => {
  tabSearch.tab = undefined;
  list.mockResolvedValue([
    { id: 1, username: "root", displayName: "Root", email: "r@x", role: "admin", provider: "local" },
  ]);
  rolesList.mockResolvedValue([
    {
      name: "admin",
      description: "Full access to all resources, including users and global config.",
      builtin: true,
      permissions: ["*"],
    },
    {
      name: "operator",
      description: "Manage game servers, backups, and templates.",
      builtin: true,
      permissions: ["servers:read", "servers:write"],
    },
    {
      name: "viewer",
      description: "Read-only access across the control panel.",
      builtin: true,
      permissions: ["servers:read"],
    },
  ]);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("UsersPage tabs", () => {
  it("Roles tab renders the three role cards", async () => {
    renderPage();
    await screen.findByText("root");
    await userEvent.click(screen.getByRole("tab", { name: /Roles/i }));
    expect(await screen.findByText(/Full access/i)).toBeInTheDocument();
    expect(screen.getByText(/Manage game servers/i)).toBeInTheDocument();
    expect(screen.getByText(/Read-only access/i)).toBeInTheDocument();
  });

  it("Service accounts tab renders the placeholder", async () => {
    renderPage();
    await screen.findByText("root");
    await userEvent.click(screen.getByRole("tab", { name: /Service accounts/i }));
    expect(
      await screen.findByText(/Service accounts.*tracked for v1\.1/i),
    ).toBeInTheDocument();
  });

  it("Identity providers tab renders the placeholder", async () => {
    renderPage();
    await screen.findByText("root");
    await userEvent.click(screen.getByRole("tab", { name: /Identity providers/i }));
    expect(
      await screen.findByText(/OIDC identity providers/i),
    ).toBeInTheDocument();
  });
});
