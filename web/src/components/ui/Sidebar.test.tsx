import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { LayoutDashboard, Server, Package, Archive, Users, Settings } from "lucide-react";
import { Sidebar } from "./Sidebar";
import type { SidebarNavGroup } from "./Sidebar";
import type { User } from "@/types";

// Mock TanStack Router
const mockLocation = { pathname: "/" };
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
  useLocation: () => mockLocation,
}));

beforeEach(() => {
  mockLocation.pathname = "/";
});

const mockUser: User = {
  id: 1,
  username: "testuser",
  displayName: "Test User",
  email: "test@example.com",
  role: "admin",
};

const generalNav: SidebarNavGroup[] = [
  {
    label: "General",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard },
      { to: "/servers", label: "Servers", icon: Server },
      { to: "/modules", label: "Modules", icon: Package },
      { to: "/backups", label: "Backups", icon: Archive },
    ],
  },
];

const adminNav: SidebarNavGroup[] = [
  ...generalNav,
  {
    label: "Admin",
    items: [
      { to: "/users", label: "Users & RBAC", icon: Users },
      { to: "/admin", label: "Settings", icon: Settings },
    ],
  },
];

describe("Sidebar", () => {
  describe("fixed variant", () => {
    it("renders nav items with icons and labels", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      expect(screen.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Servers/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Modules/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Backups/i })).toBeInTheDocument();
    });

    it("renders section labels (General, Admin)", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={adminNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      // Both sections should be visible
      const headings = screen.getAllByText(/General|Admin/i);
      expect(headings.length).toBeGreaterThanOrEqual(2);
    });

    it("only renders admin section if it has items", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      // General section should be visible
      expect(screen.getByText(/General/i)).toBeInTheDocument();

      // Admin links should NOT be visible (no admin items in fixture)
      expect(screen.queryByRole("link", { name: /Users & RBAC/i })).not.toBeInTheDocument();
    });

    it("highlights the active nav item", () => {
      mockLocation.pathname = "/servers";
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      const serversLink = screen.getByRole("link", { name: /Servers/i });
      expect(serversLink).toHaveClass("bg-primary/10");
    });

    it("calls onNavigate when a nav link is clicked", async () => {
      const onNavigate = vi.fn();
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          onNavigate={onNavigate}
          onLogout={vi.fn()}
        />
      );

      const serversLink = screen.getByRole("link", { name: /Servers/i });
      await userEvent.click(serversLink);

      expect(onNavigate).toHaveBeenCalled();
    });

    it("renders user info in footer", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      expect(screen.getByText("Test User")).toBeInTheDocument();
      expect(screen.getByText("admin")).toBeInTheDocument();
    });

    it("calls onLogout when logout button is clicked", async () => {
      const onLogout = vi.fn();
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          onLogout={onLogout}
        />
      );

      const logoutBtn = screen.getByRole("button", { name: /sign out/i });
      await userEvent.click(logoutBtn);

      expect(onLogout).toHaveBeenCalled();
    });

    it("renders appearance toggle in footer", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          theme="light"
          onThemeChange={vi.fn()}
          onLogout={vi.fn()}
        />
      );

      expect(screen.getByLabelText(/Light/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Dark/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/System/i)).toBeInTheDocument();
    });

    it("calls onThemeChange when appearance toggle is interacted", async () => {
      const onThemeChange = vi.fn();
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          theme="light"
          onThemeChange={onThemeChange}
          onLogout={vi.fn()}
        />
      );

      const darkBtn = screen.getByLabelText(/Dark/i);
      await userEvent.click(darkBtn);

      expect(onThemeChange).toHaveBeenCalledWith("dark");
    });

    it("disables the footer appearance toggle when isCustomColorsActive is true", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          theme="dark"
          onThemeChange={vi.fn()}
          onLogout={vi.fn()}
          isCustomColorsActive
        />
      );
      expect(screen.getByLabelText(/Dark/i)).toBeDisabled();
    });

    it("renders cluster name in header", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          clusterName="test-cluster"
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      expect(screen.getByText("test-cluster")).toBeInTheDocument();
    });

    it("does not render close button in fixed variant", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      expect(screen.queryByRole("button", { name: /close navigation/i })).not.toBeInTheDocument();
    });
  });

  describe("nav badges", () => {
    const badgeNav = (badge: number): SidebarNavGroup[] => [
      {
        label: "General",
        items: [{ to: "/notifications", label: "Notifications", icon: Archive, badge }],
      },
    ];

    it("shows the badge count when it is positive", () => {
      render(<Sidebar variant="fixed" navItems={badgeNav(3)} user={mockUser} onLogout={vi.fn()} />);
      expect(screen.getByRole("link", { name: /Notifications/i })).toHaveTextContent("3");
    });

    it("shows 9+ when the badge exceeds nine", () => {
      render(<Sidebar variant="fixed" navItems={badgeNav(12)} user={mockUser} onLogout={vi.fn()} />);
      expect(screen.getByRole("link", { name: /Notifications/i })).toHaveTextContent("9+");
    });

    it("shows no badge when the count is zero", () => {
      render(<Sidebar variant="fixed" navItems={badgeNav(0)} user={mockUser} onLogout={vi.fn()} />);
      const link = screen.getByRole("link", { name: /Notifications/i });
      expect(link.querySelectorAll("span")).toHaveLength(1);
      expect(link).toHaveTextContent(/^Notifications$/);
    });
  });

  describe("drawer variant", () => {
    it("uses a distinct accessible name from the fixed sidebar's nav landmark", () => {
      // The fixed sidebar (mounted separately by AppLayout, see
      // AppLayout.tsx) also renders a `<nav aria-label="Primary">`. Both
      // can be present in the accessibility tree at once whenever the
      // drawer is open, so they must not share a name — otherwise a
      // `getByRole("navigation", { name: "Primary" })` query becomes
      // ambiguous (this broke a live e2e spec: login-and-shell.spec.ts).
      render(
        <Sidebar
          variant="drawer"
          isOpen={true}
          onClose={vi.fn()}
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    });

    it("renders drawer content when isOpen is true", async () => {
      const onClose = vi.fn();
      render(
        <Sidebar
          variant="drawer"
          isOpen={true}
          onClose={onClose}
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      // Should render nav content inside drawer
      expect(screen.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
    });

    it("renders close button in drawer variant", async () => {
      const onClose = vi.fn();
      render(
        <Sidebar
          variant="drawer"
          isOpen={true}
          onClose={onClose}
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: /close navigation/i })).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", async () => {
      const onClose = vi.fn();
      render(
        <Sidebar
          variant="drawer"
          isOpen={true}
          onClose={onClose}
          navItems={generalNav}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      const closeBtn = screen.getByRole("button", { name: /close navigation/i });
      await userEvent.click(closeBtn);

      expect(onClose).toHaveBeenCalled();
    });

    it("renders appearance toggle in drawer", async () => {
      const onClose = vi.fn();
      render(
        <Sidebar
          variant="drawer"
          isOpen={true}
          onClose={onClose}
          navItems={generalNav}
          user={mockUser}
          theme="light"
          onThemeChange={vi.fn()}
          onLogout={vi.fn()}
        />
      );

      expect(screen.getByLabelText(/Light/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Dark/i)).toBeInTheDocument();
    });

    it("calls onThemeChange from appearance toggle in drawer", async () => {
      const onThemeChange = vi.fn();
      const onClose = vi.fn();
      render(
        <Sidebar
          variant="drawer"
          isOpen={true}
          onClose={onClose}
          navItems={generalNav}
          user={mockUser}
          theme="dark"
          onThemeChange={onThemeChange}
          onLogout={vi.fn()}
        />
      );

      const systemBtn = screen.getByLabelText(/System/i);
      await userEvent.click(systemBtn);

      expect(onThemeChange).toHaveBeenCalledWith("system");
    });
  });

  describe("permission gating", () => {
    it("renders only general items for viewer role", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={generalNav}
          user={{ ...mockUser, role: "viewer" }}
          onLogout={vi.fn()}
        />
      );

      // General items visible
      expect(screen.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument();

      // Admin items not visible (not in navItems)
      expect(screen.queryByRole("link", { name: /Users & RBAC/i })).not.toBeInTheDocument();
    });

    it("renders both general and admin items for admin role", () => {
      render(
        <Sidebar
          variant="fixed"
          navItems={adminNav}
          user={{ ...mockUser, role: "admin" }}
          onLogout={vi.fn()}
        />
      );

      // Both sections visible
      expect(screen.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Users & RBAC/i })).toBeInTheDocument();
    });
  });

  describe("active route detection", () => {
    it("uses exact match for routes with sibling sub-paths", () => {
      mockLocation.pathname = "/admin/audit";
      const navItems: SidebarNavGroup[] = [
        {
          label: "General",
          items: [
            { to: "/admin", label: "Settings", icon: Settings },
            { to: "/admin/audit", label: "Audit", icon: Package },
          ],
        },
      ];

      render(
        <Sidebar
          variant="fixed"
          navItems={navItems}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      const settingsLink = screen.getByRole("link", { name: /Settings/i });
      const auditLink = screen.getByRole("link", { name: /Audit/i });

      // Only audit should be active, not settings (exact match applied to /admin)
      expect(auditLink).toHaveClass("bg-primary/10");
      expect(settingsLink).not.toHaveClass("bg-primary/10");
    });

    it("uses prefix match for routes with no sibling sub-paths", () => {
      mockLocation.pathname = "/servers/my-server";
      const navItems: SidebarNavGroup[] = [
        {
          label: "General",
          items: [
            { to: "/servers", label: "Servers", icon: Server },
          ],
        },
      ];

      render(
        <Sidebar
          variant="fixed"
          navItems={navItems}
          user={mockUser}
          onLogout={vi.fn()}
        />
      );

      const serversLink = screen.getByRole("link", { name: /Servers/i });

      // Servers should be active (prefix match)
      expect(serversLink).toHaveClass("bg-primary/10");
    });

    it("highlights the Settings nav item while on /settings/theme", () => {
      mockLocation.pathname = "/settings/theme";
      const navItems: SidebarNavGroup[] = [
        {
          label: "Admin",
          items: [{ to: "/admin", label: "Settings", icon: Settings }],
        },
      ];
      render(
        <Sidebar variant="fixed" navItems={navItems} user={mockUser} onLogout={vi.fn()} />
      );
      expect(screen.getByRole("link", { name: /Settings/i })).toHaveClass("bg-primary/10");
    });
  });
});
