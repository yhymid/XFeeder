In Blender 5.3, we are introducing initial support for 3D Gaussian splats! This enables importing, editing, and rendering of fast, high-quality scene captures.
A lot of groundwork has been done to integrate 3D Gaussian splats (gsplats) into Blender natively, and we’ll continue to refine our implementation in upcoming releases. In this post, we’ll outline how to use gsplats, how they’re implemented in Blender, and what the current limitations are.
A photoscan of [DOGWALK](https://store.steampowered.com/app/3775050/DOGWALK/) assets as physical objects, rendered as Gaussian splats in Blender 5.3
A 3D scene from [OVERGROWN](https://studio.blender.org/projects/overgrown/), rendered as Gaussian splats in Blender 5.3
What are Gaussian splats?
3D Gaussian splatting is a recent rendering technique in which sets of photos are turned into a specific 3D reconstruction. This doesn’t produce a mesh, but a radiance field made of many tiny Gaussian blobs. It’s similar to a point cloud, but able to represent more varied structures. Gsplats can describe complex scenes with materials, lighting, transparency, hair, and fine details, all in a single object.

**Getting Started**
