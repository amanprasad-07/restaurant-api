import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const IMAGES: Record<string, string> = {
  "Fresh Lime Soda":
    "https://res.cloudinary.com/dqrxxsx3u/image/upload/v1793523939/LimeSoda_goholm.webp",
  "Greek Salad":
    "https://res.cloudinary.com/dqrxxsx3u/image/upload/v1793523940/GreekSalad_mehoho.webp",
  "Butter Chicken":
    "https://res.cloudinary.com/dqrxxsx3u/image/upload/v1793523941/ButterChicken_cvdytl.webp",
  "Gulab Jamun":
    "https://res.cloudinary.com/dqrxxsx3u/image/upload/v1793523941/GulabJamun_thppaq.webp",
  "Masala Chai":
    "https://res.cloudinary.com/dqrxxsx3u/image/upload/v1793523941/MasalaChai_mxu0fx.webp",
  "Vegetable Biryani":
    "https://res.cloudinary.com/dqrxxsx3u/image/upload/v1793523940/VegBiryani_xyq5mj.webp",
  "Paneer Tikka":
    "https://res.cloudinary.com/dqrxxsx3u/image/upload/v1793523938/PaneerTikka_uen6dz.webp",
};

async function main() {
  for (const [name, imageUrl] of Object.entries(IMAGES)) {
    const res = await prisma.menuItem.updateMany({
      where: { name },
      data: { imageUrl },
    });
    console.log(`${res.count ? "updated" : "NOT FOUND"}: ${name}`);
  }
}
main().finally(() => prisma.$disconnect());
