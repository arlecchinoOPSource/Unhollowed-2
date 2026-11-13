import {
  BookOpen,
  CalendarDays,
  ChartNoAxesCombined,
  CircleCheck,
  FolderKanban,
  House,
  Network,
  Settings,
  Smile,
} from "lucide-react";

export const home = { path: "/", title: "Home", icon: House };
export const settings = {
  path: "/settings",
  title: "Settings",
  icon: Settings,
};

export const features = [
  {
    path: "/documents",
    title: "Documents",
    icon: BookOpen,
    description: "Write, organize, and connect your notes.",
  },
  {
    path: "/projects",
    title: "Projects",
    icon: FolderKanban,
    description: "Give your work a plan and track its progress.",
  },
  {
    path: "/calendar",
    title: "Calendar",
    icon: CalendarDays,
    description: "Make time for what matters.",
  },
  {
    path: "/graph",
    title: "Graph",
    icon: Network,
    description: "Explore the connections between your ideas.",
  },
  {
    path: "/habits",
    title: "Habits",
    icon: CircleCheck,
    description: "Build routines and see how they develop.",
  },
  {
    path: "/mood",
    title: "Mood",
    icon: Smile,
    description: "Reflect on how you feel over time.",
  },
  {
    path: "/dashboards",
    title: "Dashboards",
    icon: ChartNoAxesCombined,
    description: "See your progress across the workspace.",
  },
];

export const pages = [home, ...features, settings];
