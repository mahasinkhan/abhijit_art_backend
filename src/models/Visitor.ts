// backend/models/Visitor.ts
import mongoose, { Schema, InferSchemaType } from "mongoose";

const visitorSchema = new Schema(
  {
    ip: { type: String, default: "" },
    city: { type: String, default: "" },
    region: { type: String, default: "" },
    country: { type: String, default: "" },
    page: { type: String, default: "" },
    referrer: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    device: { type: String, default: "desktop" },
    browser: { type: String, default: "" },
    os: { type: String, default: "" },
  },
  { timestamps: true }
);

export type VisitorDoc = InferSchemaType<typeof visitorSchema>;
export default mongoose.model("Visitor", visitorSchema);