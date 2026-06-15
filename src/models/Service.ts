// backend/models/Service.ts
import mongoose, { Schema, InferSchemaType } from "mongoose";

const serviceSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    priceFrom: { type: Number, default: 0 },
    icon: { type: String, default: "🛠️" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export type ServiceDoc = InferSchemaType<typeof serviceSchema>;
export default mongoose.model("Service", serviceSchema);