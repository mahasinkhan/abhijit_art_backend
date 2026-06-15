// backend/models/Booking.ts
import mongoose, { Schema, InferSchemaType } from "mongoose";

const bookingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    service: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    serviceName: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    notes: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "confirmed", "completed", "cancelled"],
      default: "pending",
    },
  },
  { timestamps: true }
);

export type BookingDoc = InferSchemaType<typeof bookingSchema>;
export default mongoose.model("Booking", bookingSchema);