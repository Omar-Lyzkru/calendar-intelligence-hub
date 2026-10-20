import { z } from "zod";
export const EventCategorySchema = z.enum([
  "academic_deadline",
  "exam_quiz",
  "class_academic",
  "career",
  "club_organization",
  "social",
  "meeting",
  "appointment",
  "registration_deadline",
  "hackathon_workshop",
  "other",
]);
export type EventCategory = z.infer<typeof EventCategorySchema>;
export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  academic_deadline: "Academic deadline",
  exam_quiz: "Exam / quiz",
  class_academic: "Class / academic event",
  career: "Career event",
  club_organization: "Club / organization event",
  social: "Social event",
  meeting: "Meeting",
  appointment: "Appointment",
  registration_deadline: "Registration deadline",
  hackathon_workshop: "Hackathon / workshop",
  other: "Other",
};
export const ClassificationSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["classified", "ambiguous", "other"]),
    category: EventCategorySchema,
    alternatives: z.array(EventCategorySchema.exclude(["other"])).max(10),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.alternatives).size === v.alternatives.length &&
      (v.status === "classified"
        ? v.category !== "other" && v.alternatives.length === 0
        : v.category === "other" &&
          (v.status === "ambiguous"
            ? v.alternatives.length >= 2
            : v.alternatives.length === 0)),
    "Classification summary must be consistent.",
  );
export type Classification = z.infer<typeof ClassificationSchema>;
