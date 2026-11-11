// Переписку с оформлением чата (AgentMessage) берут напрямую из "@/ui/agent-message": отсюда она ушла бы на все страницы
export { BrandLogo } from "./brand-logo";
export { CABINET_SECTIONS, KNOWLEDGE_TABS, PEOPLE_TABS, SETTINGS_SECTION, SETTINGS_TABS, isSectionActive } from "./cabinet-sections";
export type { CabinetSection, SectionTab } from "./cabinet-sections";
export { SectionTabs } from "./section-tabs";
export { DataTable } from "./data-table";
export type { DataTableColumn, DataTableProps } from "./data-table";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { PageHeader } from "./page-header";
export { Select } from "./select";
export type { SelectOption, SelectProps } from "./select";
export { SectionPlaceholder } from "./section-placeholder";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
export { ImageLink } from "./image-link";
export { VideoLink } from "./video-link";
export { CopyableLink } from "./copyable-link";
export { ArrowLink } from "./arrow-link";
export { MaxBrandIcon, TelegramBrandIcon, VkBrandIcon } from "./messenger-brand-icons";
