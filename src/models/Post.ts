// backend/models/Post.ts
import mongoose, { Schema, InferSchemaType } from "mongoose";

const postSchema = new Schema(
  {
    caption:   { type: String, default: "" },
    mediaUrl:  { type: String, required: true },
    mediaType: { type: String, enum: ["image", "video"], required: true },
    publicId:  { type: String, required: true },
  },
  { timestamps: true }
);

export type PostDoc = InferSchemaType<typeof postSchema>;
export default mongoose.model("Post", postSchema);