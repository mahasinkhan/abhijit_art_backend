// backend/models/Lead.ts
import mongoose, { Schema, InferSchemaType } from "mongoose";

const leadSchema = new Schema(
  {
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    message: { type: String, default: "" },
    page: { type: String, default: "" },
  },
  { timestamps: true }
);

export type LeadDoc = InferSchemaType<typeof leadSchema>;
export default mongoose.model("Lead", leadSchema);